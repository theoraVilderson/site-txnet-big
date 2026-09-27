package collect

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"network-service/internal/db"
	"network-service/internal/driver"
	"network-service/internal/panelstate"
	"network-service/internal/register"
)

// The loop's state on `network.*` (F-027-bt), through the cross-tenant pool:
// one pass spans every tenant's panels. These replace `MemoryCursors`,
// `MemoryDriftEvents` and the nil Progress and Rates a single-process run had,
// and the memory ones stay as what the loop is proved against.

// DB is what the stores need of the pool: db.Pool satisfies it, and a test
// can too.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (db.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Opener builds a panel's driver from its row — `opener.Opener`, the one the
// registrar tests a pending panel with, so a panel is read by exactly the
// driver it was accepted through.
type Opener interface {
	Open(ctx context.Context, p register.Pending) (driver.Driver, error)
}

// StateRestorer is told what `panel.panelState` already holds —
// `panelstate.Tracker.Restore`, so a ban written before a restart is still a
// ban after it (`contract.budget.md`).
type StateRestorer interface {
	Restore(panelID string, rec panelstate.Record)
}

// DefaultReopenAfter is how long an opened driver is kept. Every open is a
// login read through the vault, audited, so opening on every pass is two
// hundred audited reads a minute; never reopening is a re-submitted login
// that is never used. Fifteen minutes is the same wait a refusal gets.
const DefaultReopenAfter = panelstate.DefaultCooloff

// PostgresSource is Source over `network.panel`. It offers the accepted
// panels, each with its driver, its request budget and its configs, and it
// reloads the cursors for them in the same breath (`PostgresCursors.reload`).
//
// A push panel is offered too (F-027-du), for its plan and its convergence:
// the RADIUS receiver is still its collector, and its turn reads the
// receiver's totals (`PostgresCursors.Totals`), not the router. A pull panel that
// declares session counters has no reading either path could give, and is
// not offered.
type PostgresSource struct {
	DB      DB
	Opener  Opener
	Cursors *PostgresCursors
	// States is told each panel's stored state before the pass asks it. Nil
	// restores nothing.
	States StateRestorer
	// ReopenAfter bounds how long a driver is kept (DefaultReopenAfter).
	ReopenAfter time.Duration
	// OpenTimeout bounds one open, which is a vault read over HTTP
	// (DefaultPanelTimeout).
	OpenTimeout time.Duration
	Clock       func() time.Time
	Log         *slog.Logger

	mu      sync.Mutex
	drivers map[string]opened
	offered []Panel
}

// opened is one panel's driver and the row it was built from. A row that
// changed — a new address, a new budget, a new login reference — is a driver
// built again, never one kept under the old figures.
type opened struct {
	row    panelRow
	driver driver.Driver
	at     time.Time
}

// panelRow is the part of a panel row the driver is built from.
type panelRow struct {
	register.Pending
	perMinute int
}

var _ Source = (*PostgresSource)(nil)

const panelsSQL = `
SELECT id::text, "driverType"::text, "counterSemantics"::text,
       coalesce("apiBaseUrl", ''), coalesce("clientBaseUrl", ''), "panelApiCredentials",
       "reviewState"::text, "ownershipType"::text, coalesce("tenantId"::text, ''),
       coalesce("maxLineRateBps", 0)::bigint, "maxRequestsPerMinute",
       "panelState"::text, "blockedSince",
       coalesce("lagMeanSec", 0), coalesce("lagVarianceSec2", 0), "lagSamples",
       transport::text
  FROM network.panel
 WHERE "reviewState" IN ('accepted', 'accepted_low_trust')
   AND (transport = 'push' OR "counterSemantics" <> 'session')
   AND "retiredAt" IS NULL
 ORDER BY id`

func (s *PostgresSource) Panels(ctx context.Context) ([]Panel, error) {
	rows, err := s.DB.Query(ctx, panelsSQL)
	if err != nil {
		return nil, fmt.Errorf("reading panels: %w", err)
	}
	var panels []Panel
	var built []panelRow
	for rows.Next() {
		var p Panel
		var row panelRow
		var family, semantics, review, state, transport string
		var blockedSince *time.Time
		if err := rows.Scan(&p.ID, &family, &semantics,
			&row.APIBaseURL, &row.ClientBaseURL, &row.Credentials,
			&review, &p.OwnershipType, &p.TenantID,
			&p.MaxLineRateBps, &p.MaxRequestsPerMinute, &state, &blockedSince,
			&p.LagMeanSec, &p.LagVarianceSec2, &p.LagSamples, &transport); err != nil {
			rows.Close()
			return nil, fmt.Errorf("reading panels: %w", err)
		}
		p.CounterSemantics = driver.CounterSemantics(semantics)
		p.DriverType = driver.DriverType(family)
		p.Transport = driver.Transport(transport)
		p.ReviewState = driver.ReviewState(review)
		row.PanelID, row.DriverType, row.Transport, row.CounterSemantics = p.ID, driver.DriverType(family), p.Transport, p.CounterSemantics
		row.TenantID = p.TenantID
		row.perMinute = p.MaxRequestsPerMinute
		if s.States != nil {
			rec := panelstate.Record{State: panelstate.State(state)}
			if blockedSince != nil {
				rec.BlockedSince = *blockedSince
			}
			s.States.Restore(p.ID, rec)
		}
		panels, built = append(panels, p), append(built, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading panels: %w", err)
	}

	ids := make([]string, len(panels))
	for i, p := range panels {
		ids[i] = p.ID
	}
	configs, err := s.Cursors.reload(ctx, ids)
	if err != nil {
		return nil, err
	}

	offered := panels[:0]
	for i, p := range panels {
		d, err := s.driverFor(ctx, built[i])
		if err != nil {
			// One panel the vault will not open is not a pass that stops. It
			// is left out, so it is never stamped, and it ages into the
			// watchdog's alert (F-027-w) rather than into a silent gap.
			s.log().Error("panel could not be opened for collection", "panel", p.ID, "error", err)
			continue
		}
		p.Driver = d
		p.Configs = configs[p.ID]
		offered = append(offered, p)
	}
	s.forgetExcept(ids)
	s.mu.Lock()
	s.offered = append([]Panel(nil), offered...)
	s.mu.Unlock()
	return offered, nil
}

// Offered is the panels the last pass was given, with their drivers — what
// the hot loop reads through (F-027-bu), so a panel has one driver and one
// request budget whichever loop is asking. A panel the bulk pass has not
// offered yet is not read early by anyone.
func (s *PostgresSource) Offered() []Panel {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Panel(nil), s.offered...)
}

// driverFor is the panel's driver, opened once and kept until its row changes
// or it is DefaultReopenAfter old. The kept driver is the paced one, so the
// request budget remembers the previous pass: a pace built fresh every pass
// is a budget that forgets what it spent (invariant 34).
func (s *PostgresSource) driverFor(ctx context.Context, row panelRow) (driver.Driver, error) {
	now := s.now()
	s.mu.Lock()
	kept, ok := s.drivers[row.PanelID]
	s.mu.Unlock()
	if ok && kept.row == row && now.Sub(kept.at) < s.reopenAfter() {
		return kept.driver, nil
	}

	openCtx, cancel := context.WithTimeout(ctx, s.openTimeout())
	defer cancel()
	d, err := s.Opener.Open(openCtx, row.Pending)
	if err != nil {
		return nil, err
	}
	var prev driver.Driver
	if ok {
		prev = kept.driver
	}
	paced := Repaced(Panel{Driver: d, MaxRequestsPerMinute: row.perMinute}, prev).Driver

	s.mu.Lock()
	if s.drivers == nil {
		s.drivers = map[string]opened{}
	}
	s.drivers[row.PanelID] = opened{row: row, driver: paced, at: now}
	s.mu.Unlock()
	return paced, nil
}

// forgetExcept drops the drivers of panels no longer offered — withdrawn,
// refused, deleted — so nothing keeps a login for a panel we stopped reading.
func (s *PostgresSource) forgetExcept(ids []string) {
	keep := make(map[string]bool, len(ids))
	for _, id := range ids {
		keep[id] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range s.drivers {
		if !keep[id] {
			delete(s.drivers, id)
		}
	}
}

func (s *PostgresSource) reopenAfter() time.Duration {
	if s.ReopenAfter > 0 {
		return s.ReopenAfter
	}
	return DefaultReopenAfter
}

func (s *PostgresSource) openTimeout() time.Duration {
	if s.OpenTimeout > 0 {
		return s.OpenTimeout
	}
	return DefaultPanelTimeout
}

func (s *PostgresSource) now() time.Time {
	if s.Clock != nil {
		return s.Clock().UTC()
	}
	return time.Now().UTC()
}

func (s *PostgresSource) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

// PostgresCursors is Cursors over `network.config_counter_state`, held in
// memory between writes: the getters are called inside the normaliser, per
// client, and a query each is five thousand queries a pass.
//
// The row is keyed by config and the getters by the panel's client id, so the
// map is rebuilt from the join every pass (`reload`). A client re-keyed by the
// convergence pass (F-027-aa) is therefore found under its new id on the next
// pass, with the cursor it already had.
//
// Apply writes through: the database first, then the map, under one lock that
// reload also holds across its query. A reload that read the table before an
// apply committed can then never overwrite the apply's cursor with the older
// one, which would be the same bytes billed twice.
type PostgresCursors struct {
	DB DB

	mu       sync.Mutex
	counters map[string]Counter
}

var _ Cursors = (*PostgresCursors)(nil)

// cursorsSQL is every claimed client on the offered panels, with its cursor
// where it has one. A config with no `remoteId` has no client to read.
const cursorsSQL = `
SELECT c."panelId"::text, c.id::text, c."remoteId", c.protocol::text,
       s.id IS NOT NULL, coalesce(s."counterSemantics"::text, ''),
       coalesce(s."lastUpBytes", 0), coalesce(s."lastDownBytes", 0),
       coalesce(s."lifetimeUpBytes", 0), coalesce(s."lifetimeDownBytes", 0),
       s."lastObservedAt", coalesce(s."resetCount", 0), s."lastResetAt",
       p.transport = 'push', rs."in", rs."out", c."sessionBaselineBytes"
  FROM network.config c
  JOIN network.panel p ON p.id = c."panelId"
  LEFT JOIN network.config_counter_state s ON s."configId" = c.id
  CROSS JOIN LATERAL (` + sessionSumSQL + `) rs
 WHERE c."panelId" = ANY($1::uuid[])
   AND c."remoteId" IS NOT NULL`

// sessionSumSQL is one config's `radius_session` marks, summed (F-027-du).
const sessionSumSQL = `SELECT coalesce(sum(r."highWaterInBytes"), 0)::bigint AS "in",
       coalesce(sum(r."highWaterOutBytes"), 0)::bigint AS "out"
  FROM network.radius_session r WHERE r."configId" = c.id`

// reload replaces the map with what the table holds for these panels and
// returns their configs, keyed by client id, for the pass's Panel.Configs.
func (c *PostgresCursors) reload(ctx context.Context, panelIDs []string) (map[string]map[string]ConfigRef, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	rows, err := c.DB.Query(ctx, cursorsSQL, panelIDs)
	if err != nil {
		return nil, fmt.Errorf("reading cursors: %w", err)
	}
	defer rows.Close()
	configs := map[string]map[string]ConfigRef{}
	counters := map[string]Counter{}
	for rows.Next() {
		var panelID, remoteID, semantics string
		var ref ConfigRef
		var has bool
		var cur Counter
		var observed, reset *time.Time
		var push bool
		var in, out, baseline int64
		if err := rows.Scan(&panelID, &ref.ConfigID, &remoteID, &ref.Protocol, &has, &semantics,
			&cur.LastUpBytes, &cur.LastDownBytes, &cur.LifetimeUpBytes, &cur.LifetimeDownBytes,
			&observed, &cur.ResetCount, &reset, &push, &in, &out, &baseline); err != nil {
			return nil, fmt.Errorf("reading cursors: %w", err)
		}
		if configs[panelID] == nil {
			configs[panelID] = map[string]ConfigRef{}
		}
		configs[panelID][remoteID] = ref
		if push {
			counters[key(panelID, remoteID)] = SessionCounter(in, out, baseline)
			continue
		}
		if !has {
			continue
		}
		cur.Semantics = driver.CounterSemantics(semantics)
		if observed != nil {
			cur.LastObservedAt = observed.UTC()
		}
		if reset != nil {
			cur.LastResetAt = reset.UTC()
		}
		counters[key(panelID, remoteID)] = cur
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading cursors: %w", err)
	}
	c.counters = counters
	return configs, nil
}

// CursorKey is where a cursor is found: the panel, and its client id there.
type CursorKey struct{ PanelID, RemoteID string }

// Merge runs read under the lock reload and Apply hold, and folds the cursors
// it returns into the map. It is how a reader with a statement of its own —
// the hot loop's candidates (F-027-bu) — brings its cursors up to date
// between two bulk passes, with the same guarantee reload has: an apply
// cannot land between the read and the fold.
func (c *PostgresCursors) Merge(read func() (map[CursorKey]Counter, error)) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	got, err := read()
	if err != nil {
		return err
	}
	if c.counters == nil {
		c.counters = map[string]Counter{}
	}
	for k, cur := range got {
		c.counters[key(k.PanelID, k.RemoteID)] = cur
	}
	return nil
}

func (c *PostgresCursors) Counter(panelID, remoteID string) (Counter, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cur, ok := c.counters[key(panelID, remoteID)]
	return cur, ok
}

// Session is always unknown: a session panel is never offered to this loop.
func (c *PostgresCursors) Session(string, string, string) (SessionMark, bool) {
	return SessionMark{}, false
}

// applySQL moves every cursor of a pass in one statement. `lastPublishedAt`
// is the pass's clock: Apply runs only after the publish (invariant 18).
const applySQL = `
INSERT INTO network.config_counter_state AS s
       (id, "configId", "panelId", "counterSemantics", "lastUpBytes", "lastDownBytes",
        "lifetimeUpBytes", "lifetimeDownBytes", "lastObservedAt", "lastPublishedAt",
        "resetCount", "lastResetAt", "updatedAt")
SELECT gen_random_uuid(), v.config::uuid, v.panel::uuid, v.semantics::network."CounterSemantics",
       v.up, v.down, v.lifetime_up, v.lifetime_down, v.observed, $11, v.resets, v.reset_at, now()
  FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::bigint[],
              $7::bigint[], $8::timestamp(3)[], $9::int[], $10::timestamp(3)[])
       AS v(config, panel, semantics, up, down, lifetime_up, lifetime_down, observed, resets, reset_at)
ON CONFLICT ("configId") DO UPDATE
   SET "panelId" = EXCLUDED."panelId",
       "counterSemantics" = EXCLUDED."counterSemantics",
       "lastUpBytes" = EXCLUDED."lastUpBytes",
       "lastDownBytes" = EXCLUDED."lastDownBytes",
       "lifetimeUpBytes" = EXCLUDED."lifetimeUpBytes",
       "lifetimeDownBytes" = EXCLUDED."lifetimeDownBytes",
       "lastObservedAt" = EXCLUDED."lastObservedAt",
       "lastPublishedAt" = EXCLUDED."lastPublishedAt",
       "resetCount" = EXCLUDED."resetCount",
       "lastResetAt" = EXCLUDED."lastResetAt",
       "updatedAt" = EXCLUDED."updatedAt"`

// ErrUnstorableAdvance is an advance this table has no place for: a session
// mark (`radius_session`'s) or a client no config claims. Refusing the whole
// pass leaves the cursors where they were, so it is republished rather than a
// mark dropped and billed again.
var ErrUnstorableAdvance = errors.New("advance has no config_counter_state row to live in")

func (c *PostgresCursors) Apply(ctx context.Context, res Result) error {
	if len(res.Advances) == 0 {
		return nil
	}
	n := len(res.Advances)
	configs, panels, semantics := make([]string, n), make([]string, n), make([]string, n)
	up, down, lifeUp, lifeDown := make([]int64, n), make([]int64, n), make([]int64, n), make([]int64, n)
	observed, resetAt := make([]*time.Time, n), make([]*time.Time, n)
	resets := make([]int32, n)
	for i, a := range res.Advances {
		if a.Session != nil || a.ConfigID == "" {
			return fmt.Errorf("%w: panel %s client %s", ErrUnstorableAdvance, a.PanelID, a.RemoteID)
		}
		cur := a.Counter
		configs[i], panels[i], semantics[i] = a.ConfigID, a.PanelID, string(cur.Semantics)
		up[i], down[i], lifeUp[i], lifeDown[i] = cur.LastUpBytes, cur.LastDownBytes, cur.LifetimeUpBytes, cur.LifetimeDownBytes
		observed[i], resetAt[i], resets[i] = nullableTime(cur.LastObservedAt), nullableTime(cur.LastResetAt), int32(cur.ResetCount)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := c.DB.Exec(ctx, applySQL, configs, panels, semantics, up, down, lifeUp, lifeDown,
		observed, resets, resetAt, res.ObservedAt); err != nil {
		return fmt.Errorf("moving panel %s cursors: %w", res.PanelID, err)
	}
	if c.counters == nil {
		c.counters = map[string]Counter{}
	}
	for _, a := range res.Advances {
		c.counters[key(a.PanelID, a.RemoteID)] = a.Counter
	}
	return nil
}

// PostgresProgress is Progress over `panel.lastSuccessfulCollectionAt`. The
// clock never moves backward: a slow turn landing after a faster one must not
// make a panel look staler than it is.
type PostgresProgress struct {
	DB DB
}

var _ Progress = PostgresProgress{}

const progressSQL = `
UPDATE network.panel p
   SET "lastSuccessfulCollectionAt" = greatest(p."lastSuccessfulCollectionAt", v.at)
  FROM unnest($1::text[], $2::timestamp(3)[]) AS v(id, at)
 WHERE p.id = v.id::uuid`

func (s PostgresProgress) Collected(ctx context.Context, marks []PanelProgress) error {
	if len(marks) == 0 {
		return nil
	}
	ids, at := make([]string, len(marks)), make([]time.Time, len(marks))
	for i, m := range marks {
		ids[i], at[i] = m.PanelID, m.At
	}
	if _, err := s.DB.Exec(ctx, progressSQL, ids, at); err != nil {
		return fmt.Errorf("stamping collection progress: %w", err)
	}
	return nil
}

// PostgresRates is Rates over `config.observedRateBps`, the figure the hot
// loop judges membership on (`contract.hot-loop.md`).
type PostgresRates struct {
	DB DB
}

var _ Rates = PostgresRates{}

// In id order: the bulk and hot loops write the same panel's rates (F-027-cv).
var ratesSQL = db.OrderedConfigUpdate(`"observedRateBps" = v.rate`,
	`unnest($1::text[], $2::bigint[]) AS v(id, rate)`)

func (s PostgresRates) Record(ctx context.Context, samples []RateSample) error {
	if len(samples) == 0 {
		return nil
	}
	ids, rates := make([]string, len(samples)), make([]int64, len(samples))
	for i, r := range samples {
		ids[i], rates[i] = r.ConfigID, r.RateBps
	}
	if _, err := s.DB.Exec(ctx, ratesSQL, ids, rates); err != nil {
		return fmt.Errorf("recording observed rates: %w", err)
	}
	return nil
}

// PostgresDriftEvents is DriftEvents over `network.panel_drift_event`. An
// event halts until an admin acknowledges it, and nothing here acknowledges.
type PostgresDriftEvents struct {
	DB DB
}

var _ DriftEvents = PostgresDriftEvents{}

// haltedSQL is the type of the open event that halts the panel, a foreign
// claim first: it is the one that stops convergence too.
const haltedSQL = `
SELECT "eventType"::text FROM network.panel_drift_event
 WHERE "panelId" = $1::uuid AND "collectionHalted" AND "acknowledgedAt" IS NULL
 ORDER BY ("eventType" = 'foreign_claim') DESC
 LIMIT 1`

func (s PostgresDriftEvents) Halted(ctx context.Context, panelID string) (DriftEventType, error) {
	rows, err := s.DB.Query(ctx, haltedSQL, panelID)
	if err != nil {
		return "", fmt.Errorf("reading panel %s drift events: %w", panelID, err)
	}
	defer rows.Close()
	var halt string
	if rows.Next() {
		if err := rows.Scan(&halt); err != nil {
			return "", fmt.Errorf("reading panel %s drift events: %w", panelID, err)
		}
	}
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("reading panel %s drift events: %w", panelID, err)
	}
	return DriftEventType(halt), nil
}

const raiseSQL = `
INSERT INTO network.panel_drift_event
       (id, "panelId", "eventType", "foreignPanelId", "affectedConfigCount", "observedConfigCount", "detectedAt", "collectionHalted")
VALUES (gen_random_uuid(), $1::uuid, $2::network."PanelDriftEventType", $3::uuid, $4, $5, $6, $7)`

func (s PostgresDriftEvents) Raise(ctx context.Context, e DriftEvent) error {
	var foreign *string
	if e.ForeignPanelID != "" {
		foreign = &e.ForeignPanelID
	}
	if _, err := s.DB.Exec(ctx, raiseSQL, e.PanelID, string(e.Type), foreign, e.Affected, e.Observed, e.DetectedAt, e.CollectionHalted); err != nil {
		return fmt.Errorf("raising panel %s drift event: %w", e.PanelID, err)
	}
	return nil
}

func nullableTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

// SessionCounter is a push config's counter (F-027-du): its lifetime is the
// Σ of its `radius_session` marks, and the panel's own figure — User
// Manager's total, which starts at the client's create — is that Σ less the
// Σ it was created at. The offset every ceiling on it is translated by is
// therefore the baseline, as a pull panel's is the bytes its counter lost.
func SessionCounter(in, out, baseline int64) Counter {
	return Counter{
		Semantics: driver.CounterSession, LifetimeUpBytes: in, LifetimeDownBytes: out,
		LastDownBytes: max(in+out-baseline, 0),
	}
}

var _ SessionTotals = (*PostgresCursors)(nil)

// totalsSQL is every claimed client on one push panel with its sessions'
// marks summed and its baseline. A client with no session yet reads zero,
// so its Grant is planned all the same.
const totalsSQL = `
SELECT c."remoteId", rs."in", rs."out", c."sessionBaselineBytes"
  FROM network.config c
  CROSS JOIN LATERAL (` + sessionSumSQL + `) rs
 WHERE c."panelId" = $1::uuid
   AND c."remoteId" IS NOT NULL
 ORDER BY c."remoteId"`

// rebaseSQL takes the router's own totals (F-027-du). A config whose total
// went down since the last read — or that has none yet, being new since our
// create — was made on the router since: its baseline becomes what our Σ
// holds beyond the router's figure. It only ever rises: a gap that shrinks is
// the router counting a packet we have not yet, and a baseline lowered on it
// would serve those bytes twice. It moves on a drop only, never on the gap
// alone, because the two figures are read a moment apart and a baseline
// chasing that moment would climb by a packet a turn.
var rebaseSQL = db.OrderedConfigUpdate(`"sessionBaselineBytes" = CASE
         WHEN c."sessionCounterBytes" IS NULL OR v.total < c."sessionCounterBytes"
         THEN greatest(c."sessionBaselineBytes",
                       (SELECT coalesce(sum(r."highWaterInBytes" + r."highWaterOutBytes"), 0)
                          FROM network.radius_session r WHERE r."configId" = c.id) - v.total)
         ELSE c."sessionBaselineBytes" END,
       "sessionCounterBytes" = v.total`,
	`(SELECT c.id::text AS id, t.total FROM unnest($2::text[], $3::bigint[]) AS t(remote, total)
          JOIN network.config c ON c."panelId" = $1::uuid AND c."remoteId" = t.remote) AS x`)

// Totals is SessionTotals: a push panel's reading, one per claimed client,
// the figure the panel's own limit is checked against (SessionCounter),
// after rebasing on the router's own totals where the turn read them. It
// folds the same counters into the map through Merge, so the convergence
// step right after it translates each ceiling by the baseline as it now
// stands — a client re-made since the last bulk pass included.
func (c *PostgresCursors) Totals(ctx context.Context, panelID string, router []driver.ClientUsage) ([]driver.ClientUsage, error) {
	var out []driver.ClientUsage
	err := c.Merge(func() (map[CursorKey]Counter, error) {
		if len(router) > 0 {
			remotes, totals := make([]string, len(router)), make([]int64, len(router))
			for i, u := range router {
				remotes[i], totals[i] = u.RemoteID, u.UpBytes+u.DownBytes
			}
			if _, err := c.DB.Exec(ctx, rebaseSQL, panelID, remotes, totals); err != nil {
				return nil, fmt.Errorf("rebasing panel %s on its own totals: %w", panelID, err)
			}
		}
		rows, err := c.DB.Query(ctx, totalsSQL, panelID)
		if err != nil {
			return nil, fmt.Errorf("reading the session totals of panel %s: %w", panelID, err)
		}
		defer rows.Close()
		at := time.Now().UTC()
		got := map[CursorKey]Counter{}
		for rows.Next() {
			var remoteID string
			var in, sent, baseline int64
			if err := rows.Scan(&remoteID, &in, &sent, &baseline); err != nil {
				return nil, fmt.Errorf("reading the session totals of panel %s: %w", panelID, err)
			}
			cur := SessionCounter(in, sent, baseline)
			got[CursorKey{PanelID: panelID, RemoteID: remoteID}] = cur
			// One total, in DownBytes: the split of what is left past a
			// baseline is a number nobody measured (driver.ClientUsage).
			out = append(out, driver.ClientUsage{RemoteID: remoteID, DownBytes: cur.LastDownBytes, ObservedAt: at})
		}
		return got, rows.Err()
	})
	return out, err
}
