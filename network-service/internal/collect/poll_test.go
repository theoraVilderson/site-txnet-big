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

// owingPlanner is the lease planner, scripted: every turn it plans says
// whether it left the panel anything to carry (F-027-ds).
type owingPlanner struct {
	mu    sync.Mutex
	owes  bool
	turns int
}

func (s *owingPlanner) Observe(context.Context, collect.Panel, []driver.ClientUsage, time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.turns++
	return s.owes, nil
}
func (s *owingPlanner) Allocate(context.Context, collect.Panel, time.Time) error { return nil }
func (s *owingPlanner) Failed(string, time.Time)                                 {}

// dueNow asks for a read of every panel, now.
type dueNow struct{}

func (dueNow) NextPoll(string, time.Duration) (time.Time, bool) { return time.Time{}, true }

type pollRig struct {
	panel   *fake.Panel
	loop    *collect.Loop
	poller  *collect.Poller
	planner *owingPlanner
	turns   *turnLog
}

func newPollRig(t *testing.T) *pollRig {
	t.Helper()
	fp := fake.New(fake.Config{CounterSemantics: driver.CounterCumulative})
	fp.Given("c1")
	p := collect.Panel{
		ID: "panel-1", CounterSemantics: driver.CounterCumulative, Transport: driver.TransportPull,
		MaxLineRateBps: gigabit, Driver: fp, ReviewState: driver.ReviewAccepted,
		Configs: map[string]collect.ConfigRef{"c1": {ConfigID: "config-c1", Protocol: "vless"}},
	}
	r := &pollRig{panel: fp, planner: &owingPlanner{}, turns: &turnLog{}}
	now := time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)
	r.loop = &collect.Loop{
		Source:   collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) { return []collect.Panel{p}, nil }),
		Sink:     &recorder{},
		Cursors:  collect.NewMemoryCursors(),
		Ceilings: r.turns,
		Planner:  r.planner,
		Clock: func() time.Time {
			now = now.Add(5 * time.Second)
			return now
		},
	}
	r.poller = &collect.Poller{Loop: r.loop, Panels: func() []collect.Panel { return []collect.Panel{p} }, Schedule: dueNow{}}
	return r
}

func (r *pollRig) poll() {
	r.poller.Sweep(context.Background())
	r.poller.Wait()
}

// A planned poll can come every 5 s near a Grant's end, and each converge is a
// whole-panel `ListClients` plus whatever it rewrites. A poll whose plan
// changed nothing leaves the panel alone: the bulk pass is still there.
func TestAPollWhosePlanChangedNothingIsNotConverged(t *testing.T) {
	r := newPollRig(t)
	r.panel.Serve("c1", 0, 100)
	r.poll()
	if r.planner.turns != 1 {
		t.Fatalf("%d planned turns, want the poll's 1", r.planner.turns)
	}
	if n := r.turns.count("panel-1"); n != 0 {
		t.Fatalf("%d convergence(s) after a poll the plan owed nothing, want 0", n)
	}
}

func TestAPollWhosePlanMovedSomethingIsConverged(t *testing.T) {
	r := newPollRig(t)
	r.planner.owes = true
	r.panel.Serve("c1", 0, 100)
	r.poll()
	if n := r.turns.count("panel-1"); n != 1 {
		t.Fatalf("%d convergence(s) after a poll whose plan wrote, want 1", n)
	}
}

// The bulk pass is the safety net — an operator's override, a missing client,
// a ceiling left stale by a failed write — so it converges whatever the plan.
func TestTheBulkPassConvergesWhateverThePlan(t *testing.T) {
	r := newPollRig(t)
	r.panel.Serve("c1", 0, 100)
	if _, err := r.loop.Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := r.turns.count("panel-1"); n != 1 {
		t.Fatalf("%d convergence(s) after a bulk pass, want 1", n)
	}
}

// A counter zeroed on the panel invalidates the ceiling it holds without any
// plan moving: the figure is restated in the counter's new origin on the turn
// that saw the reset, poll or not.
func TestAPollThatSawAResetIsConverged(t *testing.T) {
	r := newPollRig(t)
	r.panel.Serve("c1", 0, 100)
	r.poll()
	r.panel.ZeroCounter("c1")
	r.panel.Serve("c1", 0, 10)
	r.poll()
	if n := r.turns.count("panel-1"); n != 1 {
		t.Fatalf("%d convergence(s), want 1: the poll that saw the reset", n)
	}
}
