package collect

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"network-service/internal/anchor"
	"network-service/internal/driver"
)

// The anchor on the collector's side (ADR-0130). The connection test plants
// it on a panel it takes; a panel accepted before that gets it here, on its
// first pass (F-027-ew). Every turn then looks for it before anything else
// (F-027-ex): our own = go on; another panel's = `foreign_claim` naming it,
// even with no configs; neither = `identity_lost`. Either event halts the
// panel unread and unconverged until a person says what the server is.
// The anchor is not a user: its reading is dropped before the normaliser and
// the planner see it, and the convergence pass reads the clients without it.

// Anchors is `network.panel`'s anchor columns as the pass writes them.
type Anchors interface {
	// Record writes a onto a panel that carries none. False is a panel that
	// got one meanwhile — another turn's, or the connection test's.
	Record(ctx context.Context, panelID string, a anchor.Anchor) (bool, error)
	// Holder is the panel other than panelID whose anchor one of clients is,
	// archived ones included: a server is still that panel's.
	Holder(ctx context.Context, panelID string, clients []driver.RemoteClient) (string, bool, error)
}

// ErrIdentityLost is a turn stopped by the anchor check; the event is raised.
var ErrIdentityLost = errors.New("panel does not carry its anchor; not read until the drift event is acknowledged")

// anchorTakeBackTimeout bounds deleting an anchor no row names.
const anchorTakeBackTimeout = 10 * time.Second

// identify is the anchor check, before the turn reads anything. It answers
// ErrIdentityLost once it has raised the halting event; a list that failed
// is the turn failing, as a failed read is.
func (l *Loop) identify(turnCtx, ctx context.Context, p *Panel) (string, error) {
	if l.Anchors == nil || p.Transport != driver.TransportPull || !p.Anchor.Planted() {
		return "", nil
	}
	clients, err := p.Driver.ListClients(ctx)
	if err != nil {
		l.observe(turnCtx, p.ID, err) // the panel did not answer; a halt is no outage
		return "ListClients", err
	}
	if own, ok := p.Anchor.In(clients); ok {
		p.Anchor.RemoteID = own.RemoteID // re-keyed on the panel: the tag is ours
		return "", nil
	}
	event := DriftEvent{PanelID: p.ID, Type: IdentityLost, Observed: len(clients), DetectedAt: l.now(), CollectionHalted: true}
	holder, found, err := l.Anchors.Holder(ctx, p.ID, clients)
	if err != nil {
		return "Anchor", err
	}
	if found {
		event.Type, event.ForeignPanelID, event.Affected = ForeignClaim, holder, 1
	}
	if err := l.Containment.Raise(ctx, event); err != nil {
		return "Anchor", err
	}
	l.log().Error("panel does not carry its anchor; stopped", "panel", p.ID, "event", event.Type, "foreign_panel", holder)
	return OpHalted, ErrIdentityLost
}

// backfill plants the anchor of a pull panel that has none. A panel whose
// family will not make one is read as before and asked again next pass: it
// was accepted, and halting its users over our backfill would be ours to
// answer for.
func (l *Loop) backfill(ctx context.Context, p *Panel) {
	if l.Anchors == nil || p.Transport != driver.TransportPull || p.Anchor.Planted() {
		return
	}
	a, err := anchor.Plant(ctx, p.Driver)
	if err != nil {
		l.log().Warn("panel anchor not planted; read without one", "panel", p.ID, "error", err)
		return
	}
	recorded, err := l.Anchors.Record(ctx, p.ID, a)
	if err != nil || !recorded {
		delCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), anchorTakeBackTimeout)
		defer cancel()
		if derr := p.Driver.DeleteClient(delCtx, a.RemoteID); derr != nil {
			l.log().Error("unrecorded anchor not deleted; it is disabled, remove it by hand",
				"panel", p.ID, "remoteId", a.RemoteID, "tag", a.Tag, "error", derr)
		}
		if err != nil {
			l.log().Error("panel anchor not recorded", "panel", p.ID, "error", err)
		}
		return
	}
	p.Anchor = a
}

// withoutAnchor drops the anchor's reading: it is never billed, quarantined
// or written down as unattributed.
func withoutAnchor(p Panel, readings []driver.ClientUsage) []driver.ClientUsage {
	if !p.Anchor.Planted() {
		return readings
	}
	out := readings[:0:0]
	for _, r := range readings {
		if r.RemoteID != p.Anchor.RemoteID {
			out = append(out, r)
		}
	}
	return out
}

// PostgresAnchors is Anchors over `network.panel` (F-027-ew).
type PostgresAnchors struct{ DB DB }

var _ Anchors = PostgresAnchors{}

// recordAnchorSQL writes over none only: a backfill that lost the race to
// another turn, or to a connection test, writes nothing and takes its own back.
const recordAnchorSQL = `
UPDATE network.panel
   SET "anchorTag" = $2, "anchorUuid" = $3, "anchorRemoteId" = $4
 WHERE id = $1::uuid AND "anchorTag" IS NULL AND transport = 'pull'`

func (s PostgresAnchors) Record(ctx context.Context, panelID string, a anchor.Anchor) (bool, error) {
	tag, err := s.DB.Exec(ctx, recordAnchorSQL, panelID, a.Tag, a.UUID, a.RemoteID)
	if err != nil {
		return false, fmt.Errorf("recording panel %s anchor: %w", panelID, err)
	}
	return tag.RowsAffected() == 1, nil
}

// holderSQL is the panel whose anchor tag or uuid one of the clients carries.
const holderSQL = `
SELECT id::text FROM network.panel
 WHERE id <> $1::uuid AND ("anchorTag" = ANY($2::text[]) OR "anchorUuid" = ANY($3::text[]))
 ORDER BY id LIMIT 1`

func (s PostgresAnchors) Holder(ctx context.Context, panelID string, clients []driver.RemoteClient) (string, bool, error) {
	tags, uuids := make([]string, 0, len(clients)), make([]string, 0, len(clients))
	for _, c := range clients {
		if c.Label != "" {
			tags = append(tags, c.Label)
		}
		if c.UUID != "" {
			uuids = append(uuids, c.UUID)
		}
	}
	rows, err := s.DB.Query(ctx, holderSQL, panelID, tags, uuids)
	if err != nil {
		return "", false, fmt.Errorf("reading anchor holders for panel %s: %w", panelID, err)
	}
	defer rows.Close()
	var holder string
	found := rows.Next()
	if found {
		if err := rows.Scan(&holder); err != nil {
			return "", false, fmt.Errorf("reading anchor holders for panel %s: %w", panelID, err)
		}
	}
	return holder, found, rows.Err()
}

// MemoryAnchors holds anchors in memory: what the loop is proved against.
type MemoryAnchors struct {
	mu      sync.Mutex
	byPanel map[string]anchor.Anchor
	winners map[string]anchor.Anchor
}

func NewMemoryAnchors() *MemoryAnchors {
	return &MemoryAnchors{byPanel: map[string]anchor.Anchor{}, winners: map[string]anchor.Anchor{}}
}

func (m *MemoryAnchors) Record(_ context.Context, panelID string, a anchor.Anchor) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if w, ok := m.winners[panelID]; ok {
		m.byPanel[panelID] = w
		delete(m.winners, panelID)
	}
	if m.byPanel[panelID].Planted() {
		return false, nil
	}
	m.byPanel[panelID] = a
	return true, nil
}

func (m *MemoryAnchors) Holder(_ context.Context, panelID string, clients []driver.RemoteClient) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, a := range m.byPanel {
		if _, ok := a.In(clients); ok && id != panelID {
			return id, true, nil
		}
	}
	return "", false, nil
}

// Put records a panel's anchor, as its connection test would.
func (m *MemoryAnchors) Put(panelID string, a anchor.Anchor) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.byPanel[panelID] = a
}

// Of is the anchor recorded for a panel.
func (m *MemoryAnchors) Of(panelID string) anchor.Anchor {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.byPanel[panelID]
}

// Lose makes the next Record on panelID find a already recorded, as another
// turn's backfill winning the race would.
func (m *MemoryAnchors) Lose(panelID string, a anchor.Anchor) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.winners[panelID] = a
}
