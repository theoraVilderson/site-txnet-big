package collect

import (
	"context"
	"sync"
	"time"
)

// DefaultWakeDebounce is how long a woken panel waits before its turn, so the
// configs one purchase writes — a Grant on a mirror group is one row per
// member, committed together — cost the panel one turn, not one each.
const DefaultWakeDebounce = 2 * time.Second

// Waker runs one panel's convergence turn when its desired state changed,
// instead of leaving the change to the next bulk pass (F-111-j). A purchase
// otherwise waited up to a whole interval before its client existed on the
// panel.
//
// It is a convergence turn and nothing else: no usage is read and nothing is
// published, so the counters stay the bulk pass's and the request budget pays
// one client list. It holds the panel's turn like any other turn, is gated by
// the same health, and converges a contained panel exactly as the bulk pass
// does. The bulk pass stays the safety net: a wake that is lost — the listener
// was reconnecting, the panel was not offered yet — is the old delay, never a
// config that is not placed.
type Waker struct {
	// Loop is the bulk loop whose converger, health and turn locks the woken
	// turn uses.
	Loop *Loop
	// Panels is what the bulk pass last offered (`PostgresSource.Offered`):
	// the drivers already open. A panel not in it is left to the pass, which
	// is the only place a panel is opened.
	Panels func() []Panel
	// Debounce is the per-panel window wakes fold into (DefaultWakeDebounce).
	Debounce time.Duration

	mu    sync.Mutex
	state map[string]*wakeState
}

// wakeState is one panel with a turn armed. `running` is set once the turn
// holds the panel, after which it may already have read the desired state, so
// a wake then asks for one more turn (`again`) rather than folding.
type wakeState struct {
	running bool
	again   bool
}

// Wake asks for the panel's turn. It never blocks: the turn runs on its own
// goroutine once the window has passed.
func (w *Waker) Wake(ctx context.Context, panelID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if s, ok := w.state[panelID]; ok {
		if s.running {
			s.again = true
		}
		return
	}
	w.armLocked(ctx, panelID)
}

func (w *Waker) armLocked(ctx context.Context, panelID string) {
	if w.state == nil {
		w.state = map[string]*wakeState{}
	}
	s := &wakeState{}
	w.state[panelID] = s
	time.AfterFunc(w.debounce(), func() {
		w.turn(ctx, panelID, s)
		w.mu.Lock()
		defer w.mu.Unlock()
		delete(w.state, panelID)
		if s.again && ctx.Err() == nil {
			w.armLocked(ctx, panelID)
		}
	})
}

func (w *Waker) turn(ctx context.Context, panelID string, s *wakeState) {
	if ctx.Err() != nil {
		return
	}
	p, ok := w.offered(panelID)
	if !ok || !p.ReviewState.Collectable() {
		return
	}
	l := w.Loop
	if l.Turns != nil {
		defer l.Turns.Hold(p.ID)()
	}
	w.mu.Lock()
	s.running = true
	w.mu.Unlock()
	if l.Health != nil && !l.Health.Ask(p.ID, l.now()) {
		// Inside its cool-off (F-027-v): a wake is no reason to ask a panel
		// that told us to stop. The pass after the cool-off converges it.
		return
	}
	l.log().Debug("panel woken", "panel", p.ID)
	l.converge(ctx, p, Result{PanelID: p.ID, OwnershipType: p.OwnershipType, TenantID: p.TenantID, ObservedAt: l.now()})
}

func (w *Waker) offered(panelID string) (Panel, bool) {
	if w.Panels == nil {
		return Panel{}, false
	}
	for _, p := range w.Panels() {
		if p.ID == panelID {
			return p, true
		}
	}
	return Panel{}, false
}

func (w *Waker) debounce() time.Duration {
	if w.Debounce > 0 {
		return w.Debounce
	}
	return DefaultWakeDebounce
}
