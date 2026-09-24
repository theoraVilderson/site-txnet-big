package radius

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"network-service/internal/db"
)

// TxBeginner is what PostgresStore needs of the pool: db.Pool satisfies it.
type TxBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// PostgresStore is Store over `network.radius_session`, through the
// cross-tenant pool: a NAS is one panel, and a panel spans its owner's
// tenants' users.
//
// One session is one row lock. The placeholder insert comes first so that two
// packets for a session nobody has seen yet serialise on the row rather than
// both deciding it is new — which would publish its bytes twice.
type PostgresStore struct {
	DB TxBeginner
}

var _ Store = PostgresStore{}

const placeholderSQL = `
INSERT INTO network.radius_session
       (id, "panelId", "nasId", "acctSessionId", "remoteIdentifier", "startedAt", "lastSeenAt", "updatedAt")
VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, now(), now(), now())
ON CONFLICT ("nasId", "acctSessionId") DO NOTHING`

const lockSQL = `
SELECT id::text, "panelId"::text,
       "highWaterInBytes", "highWaterOutBytes", "publishedInBytes", "publishedOutBytes",
       "gigawordsSeen", "startedAt", "lastSeenAt", "closedAt", coalesce("closeReason"::text, '')
  FROM network.radius_session
 WHERE "nasId" = $1 AND "acctSessionId" = $2
   FOR UPDATE`

const placeSQL = `
SELECT id::text, protocol::text FROM network.config
 WHERE "panelId" = $1::uuid AND "remoteId" = $2`

const storeSQL = `
UPDATE network.radius_session
   SET "configId" = $2::uuid, "remoteIdentifier" = $3,
       "highWaterInBytes" = $4, "highWaterOutBytes" = $5,
       "publishedInBytes" = $6, "publishedOutBytes" = $7,
       "gigawordsSeen" = $8, "startedAt" = $9, "lastSeenAt" = $10,
       "closedAt" = $11, "closeReason" = $12::network."RadiusSessionCloseReason",
       "updatedAt" = now()
 WHERE id = $1::uuid`

const holdSQL = `
INSERT INTO network.usage_hold (id, "configId", "panelId", "upBytes", "downBytes", reason, "heldFrom")
VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, 'gigawords_missing', $5)`

// ErrSessionOnAnotherPanel is an (nasId, acctSessionId) pair already held by
// another panel: two NASes reporting one NAS-Identifier. Keeping the bytes on
// the first panel's row would bill one owner's user for another's traffic.
var ErrSessionOnAnotherPanel = errors.New("radius: session belongs to another panel's NAS")

func (s PostgresStore) Account(ctx context.Context, k Key, remoteID string, fn Apply) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return fmt.Errorf("radius session %s: %w", k.SessionID, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, placeholderSQL, k.PanelID, k.NASID, k.SessionID, remoteID)
	if err != nil {
		return fmt.Errorf("radius session %s: %w", k.SessionID, err)
	}
	var (
		id, panelID string
		cur         Session
		closedAt    *time.Time
		reason      string
	)
	if err := tx.QueryRow(ctx, lockSQL, k.NASID, k.SessionID).Scan(&id, &panelID,
		&cur.HighInBytes, &cur.HighOutBytes, &cur.PublishedInBytes, &cur.PublishedOutBytes,
		&cur.GigawordsSeen, &cur.StartedAt, &cur.LastSeenAt, &closedAt, &reason); err != nil {
		return fmt.Errorf("radius session %s: %w", k.SessionID, err)
	}
	if panelID != k.PanelID {
		return fmt.Errorf("%w: %s on %s", ErrSessionOnAnotherPanel, k.SessionID, k.NASID)
	}
	cur.Known = tag.RowsAffected() == 0
	if closedAt != nil {
		cur.ClosedAt, cur.CloseReason = *closedAt, CloseReason(reason)
	}

	var place Placement
	err = tx.QueryRow(ctx, placeSQL, k.PanelID, remoteID).Scan(&place.ConfigID, &place.Protocol)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("placing %s: %w", remoteID, err)
	}

	next, hold, err := fn(cur, place)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, storeSQL, id, nullable(place.ConfigID), remoteID,
		next.HighInBytes, next.HighOutBytes, next.PublishedInBytes, next.PublishedOutBytes,
		next.GigawordsSeen, next.StartedAt, next.LastSeenAt,
		nullableTime(next.ClosedAt), nullable(string(next.CloseReason))); err != nil {
		return fmt.Errorf("storing radius session %s: %w", k.SessionID, err)
	}
	if hold != nil {
		if _, err := tx.Exec(ctx, holdSQL, hold.ConfigID, hold.PanelID,
			hold.UpBytes, hold.DownBytes, hold.HeldFrom); err != nil {
			return fmt.Errorf("holding radius session %s: %w", k.SessionID, err)
		}
	}
	return tx.Commit(ctx)
}

// Both closes set closedAt to lastSeenAt, not to now: the last packet is the
// last thing known about the session, in time as in bytes (invariant 27).
const closeNASSQL = `
UPDATE network.radius_session
   SET "closedAt" = "lastSeenAt", "closeReason" = 'nas_restart', "updatedAt" = now()
 WHERE "panelId" = $1::uuid AND "nasId" = $2 AND "closedAt" IS NULL`

func (s PostgresStore) CloseNAS(ctx context.Context, panelID, nasID string, _ time.Time) (int, error) {
	tag, err := s.DB.Exec(ctx, closeNASSQL, panelID, nasID)
	if err != nil {
		return 0, fmt.Errorf("closing sessions of NAS %s: %w", nasID, err)
	}
	return int(tag.RowsAffected()), nil
}

// The sweep ranges over `radius_session_closedAt_lastSeenAt_idx`.
const closeStaleSQL = `
UPDATE network.radius_session
   SET "closedAt" = "lastSeenAt", "closeReason" = 'stale_timeout', "updatedAt" = now()
 WHERE "closedAt" IS NULL AND "lastSeenAt" < $1`

func (s PostgresStore) CloseStale(ctx context.Context, cutoff time.Time) (int, error) {
	tag, err := s.DB.Exec(ctx, closeStaleSQL, cutoff)
	if err != nil {
		return 0, fmt.Errorf("closing stale radius sessions: %w", err)
	}
	return int(tag.RowsAffected()), nil
}

func nullable(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

func nullableTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

// SecretSource answers a push panel's RADIUS shared secret: opener.Vault.
// It is the panel's own vault reference, never its REST login (F-027-az), so
// this interface has no way to ask for the login.
type SecretSource interface {
	PanelRadiusSecret(ctx context.Context, panelID string) (string, error)
}

// Querier is what PanelDirectory reads panels through: db.Pool satisfies it.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (db.Rows, error)
}

// PanelDirectory is the allowlist: every accepted push panel, keyed by its
// `ipAddress`, with its RADIUS secret read through the vault. It is rebuilt whole on
// each Refresh and swapped in one step, so a lookup never sees half of one.
type PanelDirectory struct {
	DB      Querier
	Secrets SecretSource
	Log     *slog.Logger
	// MinWindow is the plausibility cap's floor for every NAS.
	MinWindow time.Duration

	nases atomic.Pointer[map[netip.Addr]NAS]
}

// DefaultRefresh is how soon a panel accepted, withdrawn or re-keyed reaches
// the allowlist.
const DefaultRefresh = time.Minute

const nasSQL = `
SELECT id::text, "ipAddress", "ownershipType"::text, coalesce("tenantId"::text, ''),
       coalesce("maxLineRateBps", 0)
  FROM network.panel
 WHERE transport = 'push' AND "reviewState" = 'accepted'`

func (d *PanelDirectory) NAS(addr netip.Addr) (NAS, bool) {
	m := d.nases.Load()
	if m == nil {
		return NAS{}, false
	}
	n, ok := (*m)[addr]
	return n, ok
}

// Refresh rebuilds the allowlist. A panel whose address does not parse, whose
// secret cannot be read, or which shares its address with another is left out
// and logged: an address two panels claim cannot say whose bytes it carries.
func (d *PanelDirectory) Refresh(ctx context.Context) error {
	rows, err := d.DB.Query(ctx, nasSQL)
	if err != nil {
		return fmt.Errorf("reading push panels: %w", err)
	}
	type candidate struct {
		nas  NAS
		addr netip.Addr
	}
	var found []candidate
	for rows.Next() {
		var c candidate
		var ip string
		if err := rows.Scan(&c.nas.PanelID, &ip, &c.nas.OwnershipType, &c.nas.TenantID,
			&c.nas.Limit.MaxLineRateBps); err != nil {
			rows.Close()
			return fmt.Errorf("reading push panels: %w", err)
		}
		addr, err := netip.ParseAddr(ip)
		if err != nil {
			d.Log.Warn("push panel left off the allowlist: ipAddress is not an address", "panel", c.nas.PanelID)
			continue
		}
		c.addr = addr.Unmap()
		c.nas.Limit.MinWindow = d.MinWindow
		found = append(found, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("reading push panels: %w", err)
	}

	claims := map[netip.Addr]int{}
	for _, c := range found {
		claims[c.addr]++
	}
	next := make(map[netip.Addr]NAS, len(found))
	for _, c := range found {
		if claims[c.addr] > 1 {
			d.Log.Warn("push panel left off the allowlist: its address is another panel's too", "panel", c.nas.PanelID)
			continue
		}
		secret, err := d.Secrets.PanelRadiusSecret(ctx, c.nas.PanelID)
		if err != nil {
			d.Log.Warn("push panel left off the allowlist: its secret could not be read", "panel", c.nas.PanelID, "error", err)
			continue
		}
		c.nas.Secret = []byte(secret)
		next[c.addr] = c.nas
	}
	d.nases.Store(&next)
	return nil
}

// Run refreshes every interval until ctx ends. A failed refresh keeps the
// allowlist it had: a database blip must not drop every NAS at once.
func (d *PanelDirectory) Run(ctx context.Context, every time.Duration) {
	if every <= 0 {
		every = DefaultRefresh
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := d.Refresh(ctx); err != nil {
				d.Log.Error("refreshing the radius allowlist failed", "error", err)
			}
		}
	}
}
