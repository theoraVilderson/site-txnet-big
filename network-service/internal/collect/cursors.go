package collect

import (
	"context"
	"sync"
)

// Cursors is the collector's memory of where each counter was — `network
// .config_counter_state` for the cumulative and reset_on_read arithmetics, and
// the per-session published high-water (`radius_session.published*Bytes`) for
// the session one.
//
// Apply is deliberately separate from the getters and takes a whole Result:
// the cursor moves **after** the pass has been published, never as it is
// computed, because a cursor stored before a failed publish is bytes nobody
// will ever read again (invariant 18). That is also what makes at-least-once
// delivery an exactly-once effect once `usage_delta_seen` absorbs the repeat
// (F-027-n).
type Cursors interface {
	Counter(panelID, remoteID string) (Counter, bool)
	Session(panelID, remoteID, sessionID string) (SessionMark, bool)
	Apply(ctx context.Context, res Result) error
}

// MemoryCursors holds cursors in memory. It is what the loop is proved against
// (F-027-l) and what a single-process run uses until the Postgres-backed
// implementation lands with the publish path (F-027-m).
type MemoryCursors struct {
	mu       sync.Mutex
	counters map[string]Counter
	sessions map[string]SessionMark
}

func NewMemoryCursors() *MemoryCursors {
	return &MemoryCursors{counters: map[string]Counter{}, sessions: map[string]SessionMark{}}
}

func (m *MemoryCursors) Counter(panelID, remoteID string) (Counter, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.counters[key(panelID, remoteID)]
	return cur, ok
}

func (m *MemoryCursors) Session(panelID, remoteID, sessionID string) (SessionMark, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mark, ok := m.sessions[key(panelID, remoteID, sessionID)]
	return mark, ok
}

func (m *MemoryCursors) Apply(_ context.Context, res Result) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, adv := range res.Advances {
		m.counters[key(adv.PanelID, adv.RemoteID)] = adv.Counter
		if adv.Session != nil {
			m.sessions[key(adv.PanelID, adv.RemoteID, adv.SessionID)] = *adv.Session
		}
	}
	return nil
}

// key joins parts with a byte that cannot appear in an id, so two different
// tuples cannot collapse into one cursor.
func key(parts ...string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += "\x00"
		}
		out += p
	}
	return out
}
