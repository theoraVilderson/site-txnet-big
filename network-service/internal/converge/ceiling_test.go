package converge_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"network-service/internal/collect"
	"network-service/internal/converge"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
)

const (
	gb      = int64(1) << 30
	gigabit = int64(1_000_000_000)
)

// ---- harness ---------------------------------------------------------------

// Every test here runs the convergence through the collection loop rather than
// calling it directly, because "in the same pass that detects a counter reset"
// (ADR-0072) is the property under test and a converger called by hand proves
// nothing about it.

type sink struct{}

func (sink) Publish(context.Context, collect.Result) error { return nil }

// recorder is the loop's converger: the real one, with its report kept.
type recorder struct {
	ceilings *converge.Ceilings

	mu      sync.Mutex
	reports []converge.Report
}

func (r *recorder) Converge(ctx context.Context, p collect.Panel, res collect.Result) error {
	report, err := r.ceilings.Pass(ctx, p, res)
	r.mu.Lock()
	r.reports = append(r.reports, report)
	r.mu.Unlock()
	return err
}

func (r *recorder) last(t *testing.T) converge.Report {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.reports) == 0 {
		t.Fatal("the pass converged nothing")
	}
	return r.reports[len(r.reports)-1]
}

type rig struct {
	panel   *fake.Panel
	loop    *collect.Loop
	store   *converge.MemoryAllocations
	reports *recorder
}

// newRig puts one client on a fake panel, attributes it to a config, and wires
// the ceiling convergence behind the collection loop.
func newRig(t *testing.T, cfg fake.Config, clients ...string) *rig {
	t.Helper()
	if cfg.CounterSemantics == "" {
		cfg.CounterSemantics = driver.CounterCumulative
	}
	p := fake.New(cfg)
	configs := map[string]collect.ConfigRef{}
	for _, id := range clients {
		p.Given(id)
		configs[id] = collect.ConfigRef{ConfigID: "config-" + id, Protocol: "vless"}
	}
	store := converge.NewMemoryAllocations()
	cursors := collect.NewMemoryCursors()
	reports := &recorder{ceilings: &converge.Ceilings{Allocations: store, Counters: cursors}}
	loop := &collect.Loop{
		Source: collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) {
			return []collect.Panel{{
				ID:               "panel-1",
				CounterSemantics: cfg.CounterSemantics,
				Transport:        driver.TransportPull,
				MaxLineRateBps:   gigabit,
				Driver:           p,
				Configs:          configs,
			}}, nil
		}),
		Sink:     sink{},
		Cursors:  cursors,
		Ceilings: reports,
	}
	return &rig{panel: p, loop: loop, store: store, reports: reports}
}

func (r *rig) allocate(remoteID string, bytes int64) {
	r.store.Allocate("panel-1", converge.Allocation{
		ConfigID: "config-" + remoteID, RemoteID: remoteID, AllocatedBytes: bytes,
	})
}

func (r *rig) pass(t *testing.T) converge.Report {
	t.Helper()
	if _, err := r.loop.Pass(context.Background()); err != nil {
		t.Fatalf("pass: %v", err)
	}
	return r.reports.last(t)
}

// enforcing is what the panel itself says it is holding — never our own side
// of the write, which is the whole point of the comparison.
func (r *rig) enforcing(t *testing.T, remoteID string) int64 {
	t.Helper()
	clients, err := r.panel.ListClients(context.Background())
	if err != nil {
		t.Fatalf("ListClients: %v", err)
	}
	for _, c := range clients {
		if c.RemoteID == remoteID {
			return c.DataLimitBytes
		}
	}
	t.Fatalf("no client %q on the panel", remoteID)
	return 0
}

func findingFor(t *testing.T, report converge.Report, configID string) converge.Finding {
	t.Helper()
	for _, f := range report.Findings {
		if f.ConfigID == configID {
			return f
		}
	}
	t.Fatalf("no finding for %q in %+v", configID, report.Findings)
	return converge.Finding{}
}

// ---- the allocation reaches the panel --------------------------------------

func TestAllocationIsWrittenToThePanel(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocate("c1", 10*gb)

	report := r.pass(t)

	if report.Written != 1 {
		t.Fatalf("written = %d, want 1: %+v", report.Written, report.Findings)
	}
	if got := r.enforcing(t, "c1"); got != 10*gb {
		t.Errorf("panel is enforcing %d, want %d", got, 10*gb)
	}
	if f := findingFor(t, report, "config-c1"); f.Reason != converge.ReasonNoLimit {
		t.Errorf("reason = %q, want %q", f.Reason, converge.ReasonNoLimit)
	}
}

// applied is what the panel confirmed, never what we sent: a write that has
// not been read back is the loop's remaining work (ADR-0072).
func TestAppliedFollowsThePanelAndNotTheWrite(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocate("c1", 10*gb)
	r.panel.DelayCeilingBy(1)

	r.pass(t)
	if _, ok := r.store.Applied("config-c1"); ok {
		t.Fatal("applied was claimed from our own write, before the panel confirmed it")
	}

	// The panel is still reporting the old ceiling, so the loop writes again.
	if report := r.pass(t); report.Written != 1 {
		t.Fatalf("second pass written = %d, want 1", report.Written)
	}

	report := r.pass(t)
	applied, ok := r.store.Applied("config-c1")
	if !ok || applied.Bytes != 10*gb {
		t.Fatalf("applied = %+v (%v), want %d", applied, ok, 10*gb)
	}
	if report.Synced != 1 || report.Written != 0 {
		t.Errorf("synced = %d, written = %d; want 1 and 0", report.Synced, report.Written)
	}
}

// ---- the reset, which is what the row exists for ---------------------------

func TestCounterResetRewritesTheCeilingInTheSamePass(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocate("c1", 10*gb)

	r.pass(t) // adopt the counter
	r.panel.Serve("c1", 0, 4*gb)
	r.pass(t) // 4 GB billed, the ceiling still the whole 10 GB
	if got := r.enforcing(t, "c1"); got != 10*gb {
		t.Fatalf("before the reset the panel is enforcing %d, want %d", got, 10*gb)
	}

	r.panel.ZeroCounter("c1")
	report := r.pass(t)

	// 4 GB the panel's counter no longer holds. A 10 GB ceiling over a zeroed
	// counter is 10 free gigabytes; the allowance left is 6 GB.
	if got := r.enforcing(t, "c1"); got != 6*gb {
		t.Errorf("panel is enforcing %d after the reset, want %d", got, 6*gb)
	}
	if f := findingFor(t, report, "config-c1"); f.Reason != converge.ReasonCounterReset {
		t.Errorf("reason = %q, want %q", f.Reason, converge.ReasonCounterReset)
	}
	if report.Written != 1 {
		t.Errorf("written = %d, want 1", report.Written)
	}
}

// ---- ADR-0072 rule 2: their number is ours to write ------------------------

func TestACeilingAboveOursIsOverwritten(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocate("c1", 10*gb)
	if err := r.panel.SetClientDataLimit(context.Background(), "c1", 500*gb); err != nil {
		t.Fatalf("operator write: %v", err)
	}

	report := r.pass(t)

	if got := r.enforcing(t, "c1"); got != 10*gb {
		t.Errorf("panel is enforcing %d, want %d", got, 10*gb)
	}
	if f := findingFor(t, report, "config-c1"); f.Reason != converge.ReasonAboveAllocation {
		t.Errorf("reason = %q, want %q", f.Reason, converge.ReasonAboveAllocation)
	}
}

func TestACeilingBelowOursIsRewrittenAndReported(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocate("c1", 10*gb)
	if err := r.panel.SetClientDataLimit(context.Background(), "c1", 1*gb); err != nil {
		t.Fatalf("operator write: %v", err)
	}

	report := r.pass(t)

	if got := r.enforcing(t, "c1"); got != 10*gb {
		t.Errorf("panel is enforcing %d, want %d", got, 10*gb)
	}
	if f := findingFor(t, report, "config-c1"); f.Reason != converge.ReasonBelowAllocation {
		t.Errorf("reason = %q, want %q", f.Reason, converge.ReasonBelowAllocation)
	}
}

// ---- the translation only ever lowers --------------------------------------

func TestBytesTheCounterHeldBeforeWeWatchedAreNotGivenHeadroom(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.panel.Serve("c1", 0, 100*gb) // already on the counter when we arrived, never billed
	r.allocate("c1", 10*gb)

	r.pass(t)

	// The first reading is a baseline, so none of those 100 GB is billed. The
	// panel counts them all the same, and covering them would be 100 GB served
	// against nobody's purchase.
	if got := r.enforcing(t, "c1"); got != 10*gb {
		t.Errorf("panel is enforcing %d, want %d", got, 10*gb)
	}
}

func TestAnAllowanceAlreadySpentBecomesACeilingOfZero(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocate("c1", 3*gb)

	r.pass(t)
	r.panel.Serve("c1", 0, 4*gb)
	r.pass(t)
	r.panel.ZeroCounter("c1")
	report := r.pass(t)

	if got := r.enforcing(t, "c1"); got != 0 {
		t.Errorf("panel is enforcing %d, want 0", got)
	}
	if f := findingFor(t, report, "config-c1"); f.Reason != converge.ReasonExhausted {
		t.Errorf("reason = %q, want %q", f.Reason, converge.ReasonExhausted)
	}
}

// ---- what it refuses to touch ----------------------------------------------

func TestAConfigWithNoAllocationIsNotWrittenTo(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")

	report := r.pass(t)

	if report.Written != 0 || report.Checked != 0 {
		t.Errorf("checked = %d, written = %d; want 0 and 0", report.Checked, report.Written)
	}
	if n := r.panel.CallCount("SetClientDataLimit"); n != 0 {
		t.Errorf("wrote to the panel %d times with nothing allocated", n)
	}
}

func TestAPanelThatCannotHoldACeilingIsReportedNotBelieved(t *testing.T) {
	r := newRig(t, fake.Config{Unsupported: map[driver.RowKey]bool{
		driver.RowPerClientDataLimit: true,
	}}, "c1")
	r.allocate("c1", 10*gb)

	report := r.pass(t)

	if report.Failed != 1 {
		t.Fatalf("failed = %d, want 1", report.Failed)
	}
	if _, ok := r.store.Applied("config-c1"); ok {
		t.Error("a ceiling the panel refused was recorded as applied")
	}
	f := findingFor(t, report, "config-c1")
	if f.Reason != converge.ReasonRefused {
		t.Errorf("reason = %q, want %q", f.Reason, converge.ReasonRefused)
	}
	var fault *driver.Fault
	if !errors.As(f.Err, &fault) || fault.Kind != driver.FaultUnsupported {
		t.Errorf("err = %v, want an unsupported fault", f.Err)
	}
}

// ---- one request, like every other pass over a panel -----------------------

func TestTheWholePanelIsReadInOneRequest(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1", "c2", "c3")
	for _, id := range []string{"c1", "c2", "c3"} {
		r.allocate(id, 10*gb)
	}

	r.pass(t)

	if n := r.panel.CallCount("ListClients"); n != 1 {
		t.Errorf("ListClients called %d times in one pass, want 1", n)
	}
}
