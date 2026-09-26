package converge

import (
	"context"
	"fmt"
	"sort"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
)

// The collector guard (F-027-cf, ADR-0090 decision 1). The connection test
// proves a new panel is not one already registered, but only at registration:
// an address edited later is tested again, and one re-pointed in DNS is not.
// Such a panel answers with another server's clients, and every pass over it
// would read them as orphans, bill their bytes as unattributed and recreate
// our own configs there as `missing`. Our claim tags and uuids are global
// (invariant 17) — a move is a new tag and a fresh uuid — so a client carrying
// another panel's is proof, the same proof the connection test takes.
//
// Only orphans are looked up: a client one of this panel's configs claims is
// ours by definition, and a panel with no orphans costs no query.

// ForeignHolder is the other panel a pass found clients of, and how many.
type ForeignHolder struct {
	PanelID string
	Clients int
}

// Claims says whose a client is when this panel's configs do not claim it.
type Claims interface {
	// Holder is the panel other than panelID holding the most configs whose
	// claim tag or uuid one of clients carries. Retired configs count: a
	// client of ours left behind is still proof of which server this is.
	Holder(ctx context.Context, panelID string, clients []driver.RemoteClient) (ForeignHolder, bool, error)
}

// ErrForeignClaim is why a guarded pass wrote nothing.
var ErrForeignClaim = fmt.Errorf("panel answers with another panel's clients; stopped until the drift event is acknowledged")

// guard raises the halting event when the orphans are another panel's. It
// runs before any write: nothing the pass would do is right on a server that
// is not this panel's. No Claims guards nothing, which is what every test of
// provisioning wants; Claims without Events fails closed.
func (v *Provisioning) guard(ctx context.Context, p collect.Panel, clients, orphans []driver.RemoteClient, at time.Time) (*ForeignHolder, error) {
	if v.Claims == nil || len(orphans) == 0 {
		return nil, nil
	}
	holder, found, err := v.Claims.Holder(ctx, p.ID, orphans)
	if err != nil || !found {
		return nil, err
	}
	if v.Events == nil {
		return &holder, fmt.Errorf("panel %s holds clients of panel %s and no drift event store is wired", p.ID, holder.PanelID)
	}
	// Two configs of the holder can match one client (one by tag, another by
	// uuid); the count is of clients, never above what the pass read.
	affected := min(holder.Clients, len(orphans))
	event := collect.DriftEvent{
		PanelID: p.ID, Type: collect.ForeignClaim, ForeignPanelID: holder.PanelID,
		Affected: affected, Observed: len(clients), DetectedAt: at, CollectionHalted: true,
	}
	if err := v.Events.Raise(ctx, event); err != nil {
		// Not raised, so not halted: the next pass looks again, and this one
		// still writes nothing.
		return &holder, err
	}
	v.log().Error("panel answers with another panel's clients; stopped",
		"panel", p.ID, "foreign_panel", holder.PanelID, "clients", affected, "observed", len(clients))
	return &holder, nil
}

// Holder over the rows in memory, by panel id order.
func (m *MemoryDesired) Holder(_ context.Context, panelID string, clients []driver.RemoteClient) (ForeignHolder, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	tags, uuids := map[string]bool{}, map[string]bool{}
	for _, c := range clients {
		if c.Label != "" {
			tags[c.Label] = true
		}
		if c.UUID != "" {
			uuids[c.UUID] = true
		}
	}
	panels := make([]string, 0, len(m.byPanel))
	for id := range m.byPanel {
		if id != panelID {
			panels = append(panels, id)
		}
	}
	sort.Strings(panels)
	var best ForeignHolder
	for _, id := range panels {
		n := 0
		for _, configID := range m.byPanel[id] {
			row := m.rows[configID]
			if tags[row.ClaimTag] || uuids[row.UUID] {
				n++
			}
		}
		if n > best.Clients {
			best = ForeignHolder{PanelID: id, Clients: n}
		}
	}
	return best, best.Clients > 0, nil
}
