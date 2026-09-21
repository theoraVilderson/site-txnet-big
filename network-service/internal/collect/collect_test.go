package collect_test

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
)

const (
	gb      = int64(1) << 30
	gigabit = int64(1_000_000_000)
)

// ---- harness ---------------------------------------------------------------

// recorder is the publish side, captured rather than sent: F-027-l stops at
// the delta stream and F-027-m carries it.
type recorder struct {
	mu      sync.Mutex
	results []collect.Result
	fail    error
	calls   int
}

func (r *recorder) Publish(ctx context.Context, res collect.Result) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	if r.fail != nil {
		return r.fail
	}
	r.results = append(r.results, res)
	return nil
}

func (r *recorder) last(t *testing.T) collect.Result {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.results) == 0 {
		t.Fatal("nothing was published")
	}
	return r.results[len(r.results)-1]
}

type rig struct {
	panel *fake.Panel
	loop  *collect.Loop
	sink  *recorder
}

// newRig wires one fake panel into a loop, with the client "c1" already on it
// and attributed to a config.
func newRig(t *testing.T, semantics driver.CounterSemantics, clients ...string) *rig {
	t.Helper()
	p := fake.New(fake.Config{CounterSemantics: semantics})
	configs := map[string]collect.ConfigRef{}
	for _, id := range clients {
		p.Given(id)
		configs[id] = collect.ConfigRef{ConfigID: "config-" + id, Protocol: "vless"}
	}
	sink := &recorder{}
	loop := &collect.Loop{
		Source: collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) {
			return []collect.Panel{{
				ID:               "panel-1",
				CounterSemantics: semantics,
				Transport:        driver.TransportPull,
				MaxLineRateBps:   gigabit,
				Driver:           p,
				Configs:          configs,
			}}, nil
		}),
		Sink:    sink,
		Cursors: collect.NewMemoryCursors(),
	}
	return &rig{panel: p, loop: loop, sink: sink}
}

func (r *rig) pass(t *testing.T) collect.PassReport {
	t.Helper()
	report, err := r.loop.Pass(context.Background())
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	return report
}

func deltaFor(t *testing.T, res collect.Result, remoteID string) collect.Delta {
	t.Helper()
	for _, d := range res.Deltas {
		if d.RemoteID == remoteID {
			return d
		}
	}
	t.Fatalf("no delta for %q in %+v", remoteID, res.Deltas)
	return collect.Delta{}
}

// ---- the defaults the row names --------------------------------------------

func TestLoopDefaultsAreTheDeclaredOnes(t *testing.T) {
	if collect.DefaultInterval != 60*time.Second {
		t.Errorf("interval = %v, want 60s", collect.DefaultInterval)
	}
	if collect.DefaultPanelTimeout != 10*time.Second {
		t.Errorf("panel timeout = %v, want 10s", collect.DefaultPanelTimeout)
	}
	if collect.DefaultConcurrency <= 0 {
		t.Errorf("concurrency = %d, want a bound", collect.DefaultConcurrency)
	}
}

// ---- adoption: we bill from the moment we started watching -----------------

func TestFirstPassAdoptsTheCounterAndPublishesNothing(t *testing.T) {
	r := newRig(t, driver.CounterCumulative, "c1")
	r.panel.Serve("c1", 4*gb, 6*gb)

	report := r.pass(t)

	if len(r.sink.last(t).Deltas) != 0 {
		t.Fatalf("first pass published %+v, want nothing: those bytes predate us", r.sink.last(t).Deltas)
	}
	if report.Quarantines != 0 {
		t.Errorf("quarantines = %d, want 0", report.Quarantines)
	}

	r.panel.Serve("c1", 0, gb)
	r.pass(t)
	if got := deltaFor(t, r.sink.last(t), "c1"); got.DownBytes != gb || got.UpBytes != 0 {
		t.Errorf("delta = %d up / %d down, want 0 / %d", got.UpBytes, got.DownBytes, gb)
	}
}

// ---- the three delta maths --------------------------------------------------

func TestCumulativeDeltaIsTheRiseSinceTheCursor(t *testing.T) {
	r := newRig(t, driver.CounterCumulative, "c1")
	r.pass(t)

	r.panel.Serve("c1", 100, 200)
	r.pass(t)
	if got := deltaFor(t, r.sink.last(t), "c1"); got.UpBytes != 100 || got.DownBytes != 200 {
		t.Fatalf("first delta = %d/%d, want 100/200", got.UpBytes, got.DownBytes)
	}

	// The counter keeps rising: the second delta is the rise, never the total.
	r.panel.Serve("c1", 50, 50)
	r.pass(t)
	if got := deltaFor(t, r.sink.last(t), "c1"); got.UpBytes != 50 || got.DownBytes != 50 {
		t.Fatalf("second delta = %d/%d, want 50/50 — a cumulative counter was billed as a total",
			got.UpBytes, got.DownBytes)
	}
}

func TestResetOnReadPublishesEveryReadingWhole(t *testing.T) {
	r := newRig(t, driver.CounterResetOnRead, "c1")
	r.panel.Serve("c1", 10, 10)
	r.pass(t) // adoption: the read zeroed the counter, and those bytes are the bounded loss

	r.panel.Serve("c1", 300, 400)
	r.pass(t)
	if got := deltaFor(t, r.sink.last(t), "c1"); got.UpBytes != 300 || got.DownBytes != 400 {
		t.Fatalf("delta = %d/%d, want 300/400", got.UpBytes, got.DownBytes)
	}

	// The source zeroed itself on the last read, so the next reading is not a
	// reset and not a repeat: it is the interval's own traffic.
	r.panel.Serve("c1", 1, 1)
	r.pass(t)
	if got := deltaFor(t, r.sink.last(t), "c1"); got.UpBytes != 1 || got.DownBytes != 1 {
		t.Fatalf("delta = %d/%d, want 1/1", got.UpBytes, got.DownBytes)
	}
}

func TestSessionDeltaIsTheRiseAboveTheSessionHighWater(t *testing.T) {
	r := newRig(t, driver.CounterSession, "c1")
	r.pass(t)

	r.panel.Serve("c1", 1000, 0)
	r.pass(t)
	if got := deltaFor(t, r.sink.last(t), "c1"); got.UpBytes != 1000 {
		t.Fatalf("delta = %d, want 1000", got.UpBytes)
	}

	// A new session starts at zero, so its whole figure is ours to bill.
	r.panel.ZeroCounter("c1")
	r.panel.Serve("c1", 500, 0)
	r.pass(t)
	if got := deltaFor(t, r.sink.last(t), "c1"); got.UpBytes != 500 {
		t.Fatalf("new session delta = %d, want 500", got.UpBytes)
	}
}

// ---- reset detection --------------------------------------------------------

func TestCumulativeResetPublishesThePostResetFigureAndNeverANegative(t *testing.T) {
	r := newRig(t, driver.CounterCumulative, "c1")
	r.pass(t)
	r.panel.Serve("c1", 5000, 5000)
	r.pass(t)

	r.panel.ZeroCounter("c1")
	r.panel.Serve("c1", 70, 30)
	r.pass(t)

	got := deltaFor(t, r.sink.last(t), "c1")
	if got.UpBytes != 70 || got.DownBytes != 30 {
		t.Fatalf("delta after reset = %d/%d, want 70/30 — the post-reset figure, whole", got.UpBytes, got.DownBytes)
	}
	if !got.AfterReset {
		t.Error("the delta does not say it followed a reset")
	}
	for _, d := range r.sink.last(t).Deltas {
		if d.UpBytes < 0 || d.DownBytes < 0 {
			t.Fatalf("a negative delta reached the stream: %+v (ADR-0074)", d)
		}
	}
}

func TestSessionSurvivesABackupRestore(t *testing.T) {
	r := newRig(t, driver.CounterSession, "c1")
	r.pass(t)
	r.panel.Serve("c1", 2*gb, 0)
	r.pass(t)
	if got := deltaFor(t, r.sink.last(t), "c1"); got.UpBytes != 2*gb {
		t.Fatalf("delta = %d, want %d", got.UpBytes, 2*gb)
	}
	r.panel.TakeBackup()

	// The restore brings back a session whose bytes we have already billed.
	r.panel.ZeroCounter("c1")
	r.panel.Serve("c1", 10, 0)
	r.pass(t)
	r.panel.RestoreBackup()
	r.pass(t)

	res := r.sink.last(t)
	for _, d := range res.Deltas {
		if d.RemoteID == "c1" && d.UpBytes != 0 {
			t.Fatalf("a restored session was billed again: %+v — the whole point of session semantics (ADR-0074)", d)
		}
	}
	if len(res.Quarantines) != 0 {
		t.Errorf("a restore under session semantics quarantined %+v; it is a non-event", res.Quarantines)
	}
}

// ---- the stretched plausibility cap ----------------------------------------

func TestAnImplausibleFigureIsQuarantinedAndNotBilled(t *testing.T) {
	r := newRig(t, driver.CounterCumulative, "c1")
	r.pass(t)

	// One pass of a 1 Gbps line carries ~7.5 GB. 40 GB did not happen.
	r.panel.Serve("c1", 40*gb, 0)
	report := r.pass(t)

	res := r.sink.last(t)
	for _, d := range res.Deltas {
		if d.RemoteID == "c1" {
			t.Fatalf("an implausible figure was billed: %+v", d)
		}
	}
	if len(res.Quarantines) != 1 {
		t.Fatalf("quarantines = %+v, want exactly one", res.Quarantines)
	}
	q := res.Quarantines[0]
	if q.Reason != collect.ReasonImplausibleVolume {
		t.Errorf("reason = %q, want %q", q.Reason, collect.ReasonImplausibleVolume)
	}
	if q.UpBytes != 40*gb {
		t.Errorf("quarantined %d bytes, want the whole figure %d — nothing is dropped (invariant 18)", q.UpBytes, 40*gb)
	}
	if report.Quarantines != 1 {
		t.Errorf("report says %d quarantines, want 1", report.Quarantines)
	}

	// The cursor advanced, so the same bytes are not quarantined for ever.
	r.panel.Serve("c1", 5, 0)
	r.pass(t)
	if got := deltaFor(t, r.sink.last(t), "c1"); got.UpBytes != 5 {
		t.Errorf("delta after a quarantine = %d, want 5", got.UpBytes)
	}
}

func TestTheCapStretchesWithTheGapItIsMeasuredOver(t *testing.T) {
	r := newRig(t, driver.CounterCumulative, "c1")
	now := time.Now().UTC()
	r.loop.Clock = func() time.Time { return now }
	r.pass(t)

	// The collector was down for two hours. 40 GB fits in that gap, and
	// quarantining it would punish the user for our outage.
	now = now.Add(2 * time.Hour)
	r.panel.Serve("c1", 40*gb, 0)
	r.pass(t)

	if got := deltaFor(t, r.sink.last(t), "c1"); got.UpBytes != 40*gb {
		t.Fatalf("delta = %d, want %d: the cap is elapsed time x line rate, not one interval", got.UpBytes, 40*gb)
	}
}

func TestAPanelWithNoDeclaredLineRateHasNoRateCap(t *testing.T) {
	p := fake.New(fake.Config{CounterSemantics: driver.CounterCumulative})
	p.Given("c1")
	sink := &recorder{}
	loop := &collect.Loop{
		Source: collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) {
			return []collect.Panel{{
				ID: "panel-1", CounterSemantics: driver.CounterCumulative,
				Transport: driver.TransportPull, Driver: p,
				Configs: map[string]collect.ConfigRef{"c1": {ConfigID: "config-c1", Protocol: "vless"}},
			}}, nil
		}),
		Sink:    sink,
		Cursors: collect.NewMemoryCursors(),
	}
	if _, err := loop.Pass(context.Background()); err != nil {
		t.Fatalf("pass: %v", err)
	}
	p.Serve("c1", 900*gb, 0)
	if _, err := loop.Pass(context.Background()); err != nil {
		t.Fatalf("pass: %v", err)
	}
	if got := deltaFor(t, sink.last(t), "c1"); got.UpBytes != 900*gb {
		t.Fatalf("delta = %d, want %d: an undeclared line rate is unknown, not zero", got.UpBytes, 900*gb)
	}
}

// ---- the cursor's own failures ----------------------------------------------

func TestAClockGoingBackwardIsQuarantinedNotBilled(t *testing.T) {
	r := newRig(t, driver.CounterCumulative, "c1")
	now := time.Now().UTC()
	r.loop.Clock = func() time.Time { return now }
	r.pass(t)

	now = now.Add(-time.Hour)
	r.panel.Serve("c1", 100, 0)
	r.pass(t)

	res := r.sink.last(t)
	if len(res.Quarantines) != 1 || res.Quarantines[0].Reason != collect.ReasonClockWentBackward {
		t.Fatalf("quarantines = %+v, want one %q", res.Quarantines, collect.ReasonClockWentBackward)
	}
	if len(res.Deltas) != 0 {
		t.Fatalf("billed from a reading we cannot bound: %+v", res.Deltas)
	}
}

func TestARedeclaredPanelInvalidatesItsCursorsRatherThanUsingThem(t *testing.T) {
	semantics := driver.CounterCumulative
	p := fake.New(fake.Config{CounterSemantics: driver.CounterCumulative})
	p.Given("c1")
	sink := &recorder{}
	loop := &collect.Loop{
		Source: collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) {
			return []collect.Panel{{
				ID: "panel-1", CounterSemantics: semantics, Transport: driver.TransportPull,
				MaxLineRateBps: gigabit, Driver: p, Configs: map[string]collect.ConfigRef{"c1": {ConfigID: "config-c1", Protocol: "vless"}},
			}}, nil
		}),
		Sink:    sink,
		Cursors: collect.NewMemoryCursors(),
	}
	if _, err := loop.Pass(context.Background()); err != nil {
		t.Fatalf("pass: %v", err)
	}
	p.Serve("c1", 1000, 0)

	// The panel is re-declared. The cursor was computed under the old
	// arithmetic and means nothing under the new one.
	semantics = driver.CounterSession
	if _, err := loop.Pass(context.Background()); err != nil {
		t.Fatalf("pass: %v", err)
	}

	res := sink.last(t)
	if len(res.Quarantines) != 1 || res.Quarantines[0].Reason != collect.ReasonSemanticsMismatch {
		t.Fatalf("quarantines = %+v, want one %q", res.Quarantines, collect.ReasonSemanticsMismatch)
	}
	if len(res.Deltas) != 0 {
		t.Fatalf("a cursor from the wrong arithmetic was billed from: %+v", res.Deltas)
	}
}

// ---- a byte that matches no config still has somewhere to go ---------------

func TestUsageWithNoConfigBecomesUnattributedRatherThanNothing(t *testing.T) {
	r := newRig(t, driver.CounterCumulative, "c1")
	r.panel.Given("stranger")
	r.pass(t)
	r.panel.Serve("stranger", 700, 300)
	r.pass(t)

	res := r.sink.last(t)
	if len(res.Unattributed) != 1 {
		t.Fatalf("unattributed = %+v, want one row for the client no config claims", res.Unattributed)
	}
	u := res.Unattributed[0]
	if u.RemoteIdentifier != "stranger" || u.UpBytes != 700 || u.DownBytes != 300 {
		t.Errorf("unattributed = %+v, want stranger 700/300", u)
	}
	for _, d := range res.Deltas {
		if d.RemoteID == "stranger" {
			t.Fatalf("an unclaimed client was billed to %q", d.ConfigID)
		}
	}
}

// ---- the loop itself --------------------------------------------------------

func TestOnePassOverAPanelCostsOneRequest(t *testing.T) {
	r := newRig(t, driver.CounterCumulative, "c1", "c2", "c3")
	before := r.panel.TotalCalls()
	r.pass(t)
	if got := r.panel.TotalCalls() - before; got != 1 {
		t.Fatalf("a pass cost %d requests, want 1 (invariant 34, catalog 8.4)", got)
	}
}

func TestASlowPanelIsCutOffAtItsTimeoutAndBillsNothing(t *testing.T) {
	r := newRig(t, driver.CounterCumulative, "c1")
	r.pass(t)
	r.panel.Serve("c1", 500, 0)
	r.loop.PanelTimeout = 30 * time.Millisecond
	r.panel.StallNextCall(2 * time.Second)

	start := time.Now()
	report := r.pass(t)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("the pass waited %v on one panel; the timeout is per panel", elapsed)
	}
	if len(report.Failed) != 1 || !driver.IsTimeout(report.Failed[0].Err) {
		t.Fatalf("failed = %+v, want one timeout", report.Failed)
	}

	// The cursor was not touched, so the bytes arrive on the next pass.
	r.loop.PanelTimeout = 0
	r.pass(t)
	if got := deltaFor(t, r.sink.last(t), "c1"); got.UpBytes != 500 {
		t.Errorf("delta after a timed-out pass = %d, want 500 — a dropped read is a hole in a counter (invariant 18)", got.UpBytes)
	}
}

func TestAFailingPanelDoesNotFailThePass(t *testing.T) {
	down := fake.New(fake.Config{CounterSemantics: driver.CounterCumulative})
	down.Given("d1")
	up := fake.New(fake.Config{CounterSemantics: driver.CounterCumulative})
	up.Given("u1")
	sink := &recorder{}
	loop := &collect.Loop{
		Source: collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) {
			return []collect.Panel{
				{ID: "down", CounterSemantics: driver.CounterCumulative, Transport: driver.TransportPull,
					MaxLineRateBps: gigabit, Driver: down, Configs: map[string]collect.ConfigRef{"d1": {ConfigID: "config-d1", Protocol: "vless"}}},
				{ID: "up", CounterSemantics: driver.CounterCumulative, Transport: driver.TransportPull,
					MaxLineRateBps: gigabit, Driver: up, Configs: map[string]collect.ConfigRef{"u1": {ConfigID: "config-u1", Protocol: "vless"}}},
			}, nil
		}),
		Sink:    sink,
		Cursors: collect.NewMemoryCursors(),
	}
	down.FailNextCall(http.StatusInternalServerError)

	report, err := loop.Pass(context.Background())
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	if report.Collected != 1 {
		t.Errorf("collected = %d, want 1", report.Collected)
	}
	if len(report.Failed) != 1 || report.Failed[0].PanelID != "down" {
		t.Fatalf("failed = %+v, want the down panel alone", report.Failed)
	}
	if !driver.IsUnavailable(report.Failed[0].Err) {
		t.Errorf("fault kind was lost: %v", report.Failed[0].Err)
	}
}

func TestConcurrencyIsBounded(t *testing.T) {
	const panels = 12
	var live, peak int64
	var mu sync.Mutex
	release := make(chan struct{})

	built := make([]collect.Panel, 0, panels)
	for i := 0; i < panels; i++ {
		p := fake.New(fake.Config{CounterSemantics: driver.CounterCumulative})
		p.Given("c1")
		built = append(built, collect.Panel{
			ID: "panel", CounterSemantics: driver.CounterCumulative, Transport: driver.TransportPull,
			MaxLineRateBps: gigabit,
			Driver: &gatedDriver{Driver: p, enter: func() {
				n := atomic.AddInt64(&live, 1)
				mu.Lock()
				if n > peak {
					peak = n
				}
				mu.Unlock()
				<-release
				atomic.AddInt64(&live, -1)
			}},
			Configs: map[string]collect.ConfigRef{"c1": {ConfigID: "config-c1", Protocol: "vless"}},
		})
	}
	loop := &collect.Loop{
		Source:      collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) { return built, nil }),
		Sink:        &recorder{},
		Cursors:     collect.NewMemoryCursors(),
		Concurrency: 3,
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, err := loop.Pass(context.Background()); err != nil {
			t.Errorf("pass: %v", err)
		}
	}()

	deadline := time.After(2 * time.Second)
	for atomic.LoadInt64(&live) < 3 {
		select {
		case <-deadline:
			t.Fatal("never reached the concurrency bound")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	time.Sleep(20 * time.Millisecond)
	mu.Lock()
	got := peak
	mu.Unlock()
	close(release)
	<-done

	if got > 3 {
		t.Fatalf("peak concurrency = %d, want at most 3: an unbounded pass is a flood over 200 panels", got)
	}
}

func TestAFailedPublishLeavesTheCursorWhereItWas(t *testing.T) {
	r := newRig(t, driver.CounterCumulative, "c1")
	r.pass(t)

	r.panel.Serve("c1", 900, 0)
	r.sink.fail = errors.New("broker down")
	report := r.pass(t)
	if len(report.Failed) != 1 {
		t.Fatalf("failed = %+v, want the publish failure reported", report.Failed)
	}

	// The same bytes are read again rather than lost: the cursor is stored
	// only after a successful publish.
	r.sink.fail = nil
	r.pass(t)
	if got := deltaFor(t, r.sink.last(t), "c1"); got.UpBytes != 900 {
		t.Fatalf("delta after a failed publish = %d, want 900 (invariant 18)", got.UpBytes)
	}
}

func TestRunPassesOnItsIntervalUntilTheContextEnds(t *testing.T) {
	r := newRig(t, driver.CounterCumulative, "c1")
	r.loop.Interval = 15 * time.Millisecond

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()
	if err := r.loop.Run(ctx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("run: %v", err)
	}
	if got := r.panel.CallCount("GetUsage"); got < 2 {
		t.Fatalf("GetUsage called %d times, want repeated passes", got)
	}
}

// gatedDriver runs enter() inside GetUsage, so a test can hold a pass open.
type gatedDriver struct {
	driver.Driver
	enter func()
}

func (g *gatedDriver) GetUsage(ctx context.Context) ([]driver.ClientUsage, error) {
	g.enter()
	return g.Driver.GetUsage(ctx)
}
