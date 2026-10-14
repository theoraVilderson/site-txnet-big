package collect

import (
	"context"
	"fmt"
	"sync"
	"time"

	"network-service/internal/anchor"
	"network-service/internal/driver"
)

// The anchor on the collector's side (F-027-ew, ADR-0130 decision 1). The
// connection test plants it on a panel it takes; a panel accepted before that
// gets it here, on its first pass. Either way the anchor is not a user: its
// reading is dropped before the normaliser and the planner see it, and the
// convergence pass reads the panel's clients without it.

// Anchors is `network.panel`'s anchor columns as the pass writes them.
type Anchors interface {
	// Record writes a onto a panel that carries none. False is a panel that
	// got one meanwhile — another turn's, or the connection test's.
	Record(ctx context.Context, panelID string, a anchor.Anchor) (bool, error)
}

// anchorTakeBackTimeout bounds deleting an anchor no row names.
const anchorTakeBackTimeout = 10 * time.Second

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
