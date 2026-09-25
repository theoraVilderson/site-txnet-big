package converge

import (
	"context"
	"fmt"
	"sync"
	"time"

	"network-service/internal/driver"
)

// A panel's inventory of inbounds (F-114-b, `contract.inbounds.md`): what the
// admin picks the sold ones from. The read owns every column of a row but the
// pick; the pick (`sold`, `maxClients`) is billing-service's, written by the
// admin, and a read never touches it — an inbound that disappears and comes
// back keeps its pick.

// MemoryInbounds is Inbounds in memory — what the pass is proved against.
type MemoryInbounds struct {
	mu     sync.Mutex
	readAt map[string]time.Time
	rows   map[string]map[string]StoredInbound
}

// StoredInbound is one inventory row as a read left it.
type StoredInbound struct {
	driver.Inbound
	// Gone is when a read stopped listing it; zero while it is listed.
	Gone time.Time
	Seen time.Time
}

func NewMemoryInbounds() *MemoryInbounds {
	return &MemoryInbounds{readAt: map[string]time.Time{}, rows: map[string]map[string]StoredInbound{}}
}

// RequestRead is the admin's refresh: the panel is due on the next pass.
func (m *MemoryInbounds) RequestRead(panelID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.readAt, panelID)
}

func (m *MemoryInbounds) Due(_ context.Context, panelID string, at time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	last, ok := m.readAt[panelID]
	return !ok || !at.Before(last.Add(InboundReadEvery)), nil
}

func (m *MemoryInbounds) Record(_ context.Context, panelID string, rows []driver.Inbound, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	stored := m.rows[panelID]
	if stored == nil {
		stored = map[string]StoredInbound{}
		m.rows[panelID] = stored
	}
	listed := map[string]bool{}
	for _, in := range rows {
		listed[in.RemoteID] = true
		stored[in.RemoteID] = StoredInbound{Inbound: in, Seen: at}
	}
	for id, row := range stored {
		if !listed[id] && row.Gone.IsZero() {
			row.Gone = at
			stored[id] = row
		}
	}
	m.readAt[panelID] = at
	return nil
}

// Get is one inbound as the last read left it.
func (m *MemoryInbounds) Get(panelID, remoteID string) (StoredInbound, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.rows[panelID][remoteID]
	return row, ok
}

// PostgresInbounds is Inbounds over `network.panel_inbound` and
// `network.panel.inboundsReadAt`, through the cross-tenant pool.
type PostgresInbounds struct {
	DB DB
}

var _ Inbounds = PostgresInbounds{}

const inboundsDueSQL = `
SELECT "inboundsReadAt" IS NULL OR "inboundsReadAt" <= $2::timestamp - make_interval(secs => $3)
  FROM network.panel WHERE id = $1::uuid`

func (s PostgresInbounds) Due(ctx context.Context, panelID string, at time.Time) (bool, error) {
	rows, err := s.DB.Query(ctx, inboundsDueSQL, panelID, at.UTC(), InboundReadEvery.Seconds())
	if err != nil {
		return false, fmt.Errorf("reading panel %s inventory age: %w", panelID, err)
	}
	defer rows.Close()
	due := false
	if rows.Next() {
		if err := rows.Scan(&due); err != nil {
			return false, fmt.Errorf("reading panel %s inventory age: %w", panelID, err)
		}
	}
	return due, rows.Err()
}

// upsertInboundSQL writes the panel's columns of one row and never the pick.
// A protocol that is not one of `ConfigProtocol` is stored as null: such an
// inbound is listed for the admin to see and can never be sold.
const upsertInboundSQL = `
INSERT INTO network.panel_inbound ("panelId", "remoteId", tag, protocol, port, host, enabled, "goneAt", "seenAt")
VALUES ($1::uuid, $2, $3,
        CASE WHEN $4 = ANY(enum_range(NULL::network."ConfigProtocol")::text[]) THEN $4::network."ConfigProtocol" END,
        $5, $6, $7, NULL, $8)
ON CONFLICT ("panelId", "remoteId") DO UPDATE
   SET tag = EXCLUDED.tag, protocol = EXCLUDED.protocol, port = EXCLUDED.port, host = EXCLUDED.host,
       enabled = EXCLUDED.enabled, "goneAt" = NULL, "seenAt" = EXCLUDED."seenAt"`

const goneInboundsSQL = `
UPDATE network.panel_inbound SET "goneAt" = $3
 WHERE "panelId" = $1::uuid AND "goneAt" IS NULL AND NOT ("remoteId" = ANY($2::text[]))`

const inboundsReadSQL = `UPDATE network.panel SET "inboundsReadAt" = $2 WHERE id = $1::uuid`

func (s PostgresInbounds) Record(ctx context.Context, panelID string, rows []driver.Inbound, at time.Time) error {
	at = at.UTC()
	ids := make([]string, 0, len(rows))
	for _, in := range rows {
		ids = append(ids, in.RemoteID)
		if _, err := s.DB.Exec(ctx, upsertInboundSQL, panelID, in.RemoteID, in.Tag, in.Protocol, in.Port, in.Host, in.Enabled, at); err != nil {
			return fmt.Errorf("writing panel %s inbound %s: %w", panelID, in.RemoteID, err)
		}
	}
	if _, err := s.DB.Exec(ctx, goneInboundsSQL, panelID, ids, at); err != nil {
		return fmt.Errorf("marking panel %s inbounds gone: %w", panelID, err)
	}
	if _, err := s.DB.Exec(ctx, inboundsReadSQL, panelID, at); err != nil {
		return fmt.Errorf("stamping panel %s inbounds read: %w", panelID, err)
	}
	return nil
}
