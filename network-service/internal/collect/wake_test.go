package collect_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
)

// F-111-j: a new config wakes its panel's convergence turn at once. These
// prove the waker's half — debounced per panel, a convergence turn and not a
// collection one, and only for a panel the bulk pass already offers.

const wakeDebounce = 20 * time.Millisecond

// turnLog is the convergence side, captured: which panel was converged, and
// over what result.
type turnLog struct {
	mu    sync.Mutex
	turns []collect.Result
	hold  chan struct{}
}

func (l *turnLog) Converge(_ context.Context, p collect.Panel, res collect.Result) error {
	if l.hold != nil {
		<-l.hold
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.turns = append(l.turns, res)
	return nil
}

func (l *turnLog) count(panelID string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, r := range l.turns {
		if r.PanelID == panelID {
			n++
		}
	}
	return n
}

type refusing struct{ panelID string }

func (r refusing) Ask(panelID string, _ time.Time) bool { return panelID != r.panelID }
func (refusing) Observe(context.Context, string, error, time.Time) error {
	return nil
}

type wakeRig struct {
	waker  *collect.Waker
	turns  *turnLog
	sink   *recorder
	panels map[string]*fake.Panel
	locks  *collect.TurnLocks
}

func newWakeRig(t *testing.T, ids ...string) *wakeRig {
	t.Helper()
	r := &wakeRig{turns: &turnLog{}, sink: &recorder{}, panels: map[string]*fake.Panel{}, locks: &collect.TurnLocks{}}
	var offered []collect.Panel
	for _, id := range ids {
		p := fake.New(fake.Config{CounterSemantics: driver.CounterCumulative})
		r.panels[id] = p
		offered = append(offered, collect.Panel{
			ID: id, CounterSemantics: driver.CounterCumulative, Transport: driver.TransportPull,
			Driver: p, ReviewState: driver.ReviewAccepted,
		})
	}
	loop := &collect.Loop{
		Source:   collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) { return offered, nil }),
		Sink:     r.sink,
		Cursors:  collect.NewMemoryCursors(),
		Ceilings: r.turns,
		Turns:    r.locks,
	}
	r.waker = &collect.Waker{Loop: loop, Panels: func() []collect.Panel { return offered }, Debounce: wakeDebounce}
	return r
}

// settle waits long enough for every armed debounce to fire and its turn to end.
func settle() { time.Sleep(6 * wakeDebounce) }

func TestAWakeConvergesItsPanelWithoutWaitingForThePass(t *testing.T) {
	r := newWakeRig(t, "panel-1")
	r.waker.Wake(context.Background(), "panel-1")
	settle()
	if got := r.turns.count("panel-1"); got != 1 {
		t.Fatalf("panel-1 converged %d times after one wake, want 1", got)
	}
	// A convergence turn, not a collection one: the counters stay the minute
	// loop's, so no usage is read and nothing is published.
	if calls := r.panels["panel-1"].CallCount("GetUsage"); calls != 0 {
		t.Fatalf("a wake read usage %d times, want 0", calls)
	}
	if r.sink.calls != 0 {
		t.Fatal("a wake published a pass")
	}
}

func TestWakesInsideTheWindowFoldIntoOneTurnPerPanel(t *testing.T) {
	r := newWakeRig(t, "panel-1", "panel-2")
	for i := 0; i < 10; i++ {
		r.waker.Wake(context.Background(), "panel-1")
	}
	r.waker.Wake(context.Background(), "panel-2")
	settle()
	if got := r.turns.count("panel-1"); got != 1 {
		t.Fatalf("ten wakes of panel-1 cost %d turns, want 1 (debounced)", got)
	}
	if got := r.turns.count("panel-2"); got != 1 {
		t.Fatalf("panel-2 converged %d times, want 1: one panel's window must not swallow another's", got)
	}
}

func TestAWakeDuringATurnRunsOneMoreTurnAfterIt(t *testing.T) {
	r := newWakeRig(t, "panel-1")
	r.turns.hold = make(chan struct{})
	r.waker.Wake(context.Background(), "panel-1")
	time.Sleep(3 * wakeDebounce) // the first turn is now inside Converge
	// Committed after that turn read its desired state: it must not wait a minute.
	r.waker.Wake(context.Background(), "panel-1")
	r.waker.Wake(context.Background(), "panel-1")
	close(r.turns.hold)
	settle()
	if got := r.turns.count("panel-1"); got != 2 {
		t.Fatalf("panel-1 converged %d times, want 2: the turn in flight, then one for the wakes it missed", got)
	}
}

func TestAWokenTurnWaitsForTheBulkTurnOnItsPanel(t *testing.T) {
	r := newWakeRig(t, "panel-1")
	release := r.locks.Hold("panel-1")
	r.waker.Wake(context.Background(), "panel-1")
	settle()
	if got := r.turns.count("panel-1"); got != 0 {
		t.Fatalf("panel-1 converged %d times while another turn held it, want 0", got)
	}
	release()
	settle()
	if got := r.turns.count("panel-1"); got != 1 {
		t.Fatalf("panel-1 converged %d times after the turn was released, want 1", got)
	}
}

func TestAWakeForAPanelThePassDoesNotOfferIsIgnored(t *testing.T) {
	r := newWakeRig(t, "panel-1")
	r.waker.Wake(context.Background(), "panel-9")
	settle()
	if got := r.turns.count("panel-9"); got != 0 {
		t.Fatalf("an unoffered panel was converged %d times, want 0", got)
	}
}

func TestAWakeDoesNotAskAPanelThatIsRefusingUs(t *testing.T) {
	r := newWakeRig(t, "panel-1")
	r.waker.Loop.Health = refusing{panelID: "panel-1"}
	r.waker.Wake(context.Background(), "panel-1")
	settle()
	if got := r.turns.count("panel-1"); got != 0 {
		t.Fatalf("a panel inside its cool-off was converged %d times, want 0 (F-027-v)", got)
	}
}

// F-111-n: a pass that wrote to a panel asks for the read that confirms it,
// ~2s later instead of on the next minute's pass.

func (l *turnLog) confirming(panelID string) []bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []bool
	for _, r := range l.turns {
		if r.PanelID == panelID {
			out = append(out, r.Confirming)
		}
	}
	return out
}

func TestAConfirmRunsOneTurnMarkedConfirming(t *testing.T) {
	r := newWakeRig(t, "panel-1")
	r.waker.Confirm(context.Background(), "panel-1")
	r.waker.Confirm(context.Background(), "panel-1")
	settle()
	if got := r.turns.confirming("panel-1"); len(got) != 1 || !got[0] {
		t.Fatalf("turns = %v, want one confirming turn", got)
	}
}

func TestAConfirmAskedDuringATurnRunsAConfirmingTurnAfterIt(t *testing.T) {
	r := newWakeRig(t, "panel-1")
	r.turns.hold = make(chan struct{})
	r.waker.Wake(context.Background(), "panel-1")
	time.Sleep(3 * wakeDebounce) // the woken turn is inside Converge, as its own write would ask
	r.waker.Confirm(context.Background(), "panel-1")
	close(r.turns.hold)
	settle()
	if got := r.turns.confirming("panel-1"); len(got) != 2 || got[0] || !got[1] {
		t.Fatalf("turns = %v, want the woken turn, then a confirming one", got)
	}
}

func TestAWakeAndAConfirmInOneWindowAreOneOrdinaryTurn(t *testing.T) {
	r := newWakeRig(t, "panel-1")
	r.waker.Confirm(context.Background(), "panel-1")
	r.waker.Wake(context.Background(), "panel-1")
	settle()
	// Ordinary, so a write it makes for the new desired state is confirmed in turn.
	if got := r.turns.confirming("panel-1"); len(got) != 1 || got[0] {
		t.Fatalf("turns = %v, want one ordinary turn", got)
	}
}
