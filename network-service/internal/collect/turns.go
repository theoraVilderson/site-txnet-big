package collect

import "sync"

// TurnLocks is one lock per panel, shared by the bulk and the hot loop
// (F-027-bu). A turn reads a panel, normalises against its cursors, publishes
// and only then moves them; two turns on one panel at once would both
// normalise against the same cursor and publish the same bytes under two
// delta ids, which `usage_delta_seen` cannot absorb. The request budget's
// single-flight shares the *read*; this is what keeps the *arithmetic* single.
//
// The bulk loop waits for the lock: a hot turn is one subset read, bounded by
// its panel timeout. The hot loop never waits: the bulk read covers every
// client on the panel, the hot ones included, so it steps aside.
type TurnLocks struct {
	mu      sync.Mutex
	byPanel map[string]*sync.Mutex
}

// Hold waits for the panel's turn and returns its release.
func (t *TurnLocks) Hold(panelID string) func() {
	m := t.lock(panelID)
	m.Lock()
	return m.Unlock
}

// TryHold takes the panel's turn only if nobody holds it.
func (t *TurnLocks) TryHold(panelID string) (func(), bool) {
	m := t.lock(panelID)
	if !m.TryLock() {
		return nil, false
	}
	return m.Unlock, true
}

func (t *TurnLocks) lock(panelID string) *sync.Mutex {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.byPanel == nil {
		t.byPanel = map[string]*sync.Mutex{}
	}
	m, ok := t.byPanel[panelID]
	if !ok {
		m = &sync.Mutex{}
		t.byPanel[panelID] = m
	}
	return m
}
