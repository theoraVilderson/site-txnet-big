package shutdown_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
	"network-service/internal/shutdown"
)

const (
	gb      = int64(1) << 30
	gigabit = int64(1_000_000_000)
)

// ---- harness ---------------------------------------------------------------

type rig struct {
	panels   map[string]*fake.Panel
	reserves *shutdown.MemoryReserves
	cursors  counters
	extender *shutdown.Extender
}

// counters is the collector's memory of where each counter was, scripted.
// `collect.MemoryCursors` only moves on a published pass, and there is no pass
// here — a shutdown extension reads the cursors and never advances them.
type counters map[string]collect.Counter

func (c counters) Counter(panelID, remoteID string) (collect.Counter, bool) {
	cur, ok := c[panelID+"/"+remoteID]
	return cur, ok
}

func (c counters) adopt(panelID, remoteID string, cur collect.Counter) {
	c[panelID+"/"+remoteID] = cur
}

// newRig wires one or more fake panels, each carrying the clients named for
// it, behind an extender with nothing else attached.
func newRig(t *testing.T, panels map[string][]string) *rig {
	t.Helper()
	fakes := map[string]*fake.Panel{}
	rows := make([]collect.Panel, 0, len(panels))
	for panelID, clients := range panels {
		p := fake.New(fake.Config{CounterSemantics: driver.CounterCumulative})
		configs := map[string]collect.ConfigRef{}
		for _, id := range clients {
			p.Given(id)
			configs[id] = collect.ConfigRef{ConfigID: "config-" + id, Protocol: "vless"}
		}
		fakes[panelID] = p
		rows = append(rows, collect.Panel{
			ID:               panelID,
			CounterSemantics: driver.CounterCumulative,
			Transport:        driver.TransportPull,
			MaxLineRateBps:   gigabit,
			Driver:           p,
			Configs:          configs,
		})
	}
	reserves := shutdown.NewMemoryReserves()
	cursors := counters{}
	return &rig{
		panels:   fakes,
		reserves: reserves,
		cursors:  cursors,
		extender: &shutdown.Extender{
			Source: collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) {
				return append([]collect.Panel(nil), rows...), nil
			}),
			Reserves: reserves,
			Counters: cursors,
		},
	}
}

func (r *rig) reserve(panelID, remoteID string, allocated, walletBacked int64) {
	r.reserves.Set(panelID, shutdown.Extension{
		ConfigID: "config-" + remoteID, RemoteID: remoteID,
		AllocatedBytes: allocated, WalletBackedBytes: walletBacked,
	})
}

func (r *rig) run(t *testing.T) shutdown.Report {
	t.Helper()
	report, err := r.extender.Run(context.Background())
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	return report
}

// enforcing is what the panel itself says it holds — never our side of the
// write, for the same reason F-027-t reads it back.
func (r *rig) enforcing(t *testing.T, panelID, remoteID string) int64 {
	t.Helper()
	clients, err := r.panels[panelID].ListClients(context.Background())
	if err != nil {
		t.Fatalf("ListClients: %v", err)
	}
	for _, c := range clients {
		if c.RemoteID == remoteID {
			return c.DataLimitBytes
		}
	}
	t.Fatalf("no client %q on %q", remoteID, panelID)
	return 0
}

// ---- what the extension is for ---------------------------------------------

func TestACeilingIsRaisedToWhatTheWalletStillBacks(t *testing.T) {
	// The reason the row exists. While the collector is down nothing measures
	// and nothing buys, so a ceiling sized for two minutes of this user's own
	// traffic (F-027-u) is a user cut off mid-download with money in their
	// wallet and nothing wrong anywhere.
	r := newRig(t, map[string][]string{"panel-1": {"c1"}})
	r.panels["panel-1"].SetClientDataLimit(context.Background(), "c1", 2*gb)
	r.reserve("panel-1", "c1", 2*gb, 50*gb)

	report := r.run(t)

	if got := r.enforcing(t, "panel-1", "c1"); got != 50*gb {
		t.Errorf("panel is enforcing %d, want %d", got, 50*gb)
	}
	if report.Raised != 1 {
		t.Errorf("raised = %d, want 1", report.Raised)
	}
}

func TestAnExtensionOnlyEverExtends(t *testing.T) {
	// A shutdown that *lowered* a ceiling would be the cut-off this row exists
	// to prevent, arriving from the code meant to prevent it. Whatever the
	// panel already holds above the figure stays.
	r := newRig(t, map[string][]string{"panel-1": {"c1"}})
	r.panels["panel-1"].SetClientDataLimit(context.Background(), "c1", 80*gb)
	r.reserve("panel-1", "c1", 2*gb, 50*gb)

	report := r.run(t)

	if got := r.enforcing(t, "panel-1", "c1"); got != 80*gb {
		t.Errorf("panel is enforcing %d, want the larger %d it already had", got, 80*gb)
	}
	if report.Raised != 0 || report.Skipped != 1 {
		t.Errorf("raised = %d, skipped = %d, want 0 and 1", report.Raised, report.Skipped)
	}
}

func TestAnEmptyWalletIsNeverWrittenAsNoLimit(t *testing.T) {
	// Zero read off a panel means *no limit* (`driver.RemoteClient`), so
	// writing zero is the one mistake here that hands out free traffic rather
	// than withholding it. A user whose money has run out keeps the ceiling
	// they had; cutting them off for real is F-027-x's.
	r := newRig(t, map[string][]string{"panel-1": {"c1"}})
	r.panels["panel-1"].SetClientDataLimit(context.Background(), "c1", 2*gb)
	r.reserve("panel-1", "c1", 0, 0)

	report := r.run(t)

	if got := r.enforcing(t, "panel-1", "c1"); got != 2*gb {
		t.Errorf("panel is enforcing %d, want its existing %d", got, 2*gb)
	}
	if report.Raised != 0 {
		t.Errorf("raised = %d, want 0", report.Raised)
	}
}

func TestTheFigureIsTranslatedIntoTheCountersOwnOrigin(t *testing.T) {
	// An allowance is lifetime bytes for the config; a panel enforces against
	// its own counter. The same translation F-027-t does, from the same
	// function — written twice, the two would drift into a wrong limit on
	// somebody else's server.
	r := newRig(t, map[string][]string{"panel-1": {"c1"}})
	r.panels["panel-1"].Serve("c1", 3*gb, gb)
	// A pass has read 4 GB off this counter and billed it, and the counter
	// still reads 4 GB: no reset, so the offset is zero and nothing is lost.
	r.cursors.adopt("panel-1", "c1", collect.Counter{
		LastUpBytes: 3 * gb, LastDownBytes: gb,
		LifetimeUpBytes: 3 * gb, LifetimeDownBytes: gb,
	})
	r.reserve("panel-1", "c1", 4*gb, 50*gb)

	r.run(t)

	if got := r.enforcing(t, "panel-1", "c1"); got != 50*gb {
		t.Errorf("panel is enforcing %d, want %d", got, 50*gb)
	}
}

func TestBytesTheCounterLostGetNoHeadroom(t *testing.T) {
	// The counter was zeroed by a restore and the config has 4 GB of lifetime
	// bytes the panel no longer holds. The extension is restated over the
	// counter's new origin — it only ever lowers on the way through, which is
	// what keeps the money bound intact across a reset.
	r := newRig(t, map[string][]string{"panel-1": {"c1"}})
	r.cursors.adopt("panel-1", "c1", collect.Counter{
		LastUpBytes: 0, LastDownBytes: 0,
		LifetimeUpBytes: 3 * gb, LifetimeDownBytes: gb,
	})
	r.reserve("panel-1", "c1", 4*gb, 50*gb)

	r.run(t)

	if got, want := r.enforcing(t, "panel-1", "c1"), 46*gb; got != want {
		t.Errorf("panel is enforcing %d, want %d — the allowance less what its counter lost", got, want)
	}
}

// ---- it is still somebody else's server ------------------------------------

func TestARefusingPanelIsNotAskedEvenOnTheWayOut(t *testing.T) {
	// A ban is a ban. Retrying through one is what makes it permanent
	// (F-027-v), and a shutdown is the worst moment to earn a permanent ban:
	// nobody is watching, and the next start inherits it.
	r := newRig(t, map[string][]string{"panel-1": {"c1"}})
	r.reserve("panel-1", "c1", 2*gb, 50*gb)
	r.extender.Health = blocked{}

	report := r.run(t)

	if calls := r.panels["panel-1"].TotalCalls(); calls != 0 {
		t.Errorf("the panel was called %d times, want none", calls)
	}
	if report.Refused != 1 {
		t.Errorf("refused = %d, want 1", report.Refused)
	}
}

func TestOnePanelsFailureDoesNotStopTheOthers(t *testing.T) {
	// The same rule the collection pass holds: one unreachable panel must not
	// leave the other hundred's users cut off for the length of a deploy.
	r := newRig(t, map[string][]string{"down": {"d1"}, "up": {"u1"}})
	r.reserve("down", "d1", 2*gb, 50*gb)
	r.reserve("up", "u1", 2*gb, 50*gb)
	r.panels["down"].FailNextCall(http.StatusInternalServerError)

	report := r.run(t)

	if got := r.enforcing(t, "up", "u1"); got != 50*gb {
		t.Errorf("the reachable panel is enforcing %d, want %d", got, 50*gb)
	}
	if report.Failed != 1 || report.Raised != 1 {
		t.Errorf("failed = %d, raised = %d, want 1 and 1", report.Failed, report.Raised)
	}
}

func TestThePopulationCostsOneReadPerPanel(t *testing.T) {
	// Catalog 8.4 does not stop applying because the process is exiting. Five
	// thousand clients read one at a time is a flood on a machine we do not
	// own, and a flood during a deploy is the one nobody is watching.
	r := newRig(t, map[string][]string{"panel-1": {"c1", "c2", "c3"}})
	for _, id := range []string{"c1", "c2", "c3"} {
		r.reserve("panel-1", id, 2*gb, 50*gb)
	}

	r.run(t)

	if reads := r.panels["panel-1"].CallCount("ListClients"); reads != 1 {
		t.Errorf("ListClients was called %d times, want 1", reads)
	}
}

func TestAnExtensionIsBoundedByItsDeadline(t *testing.T) {
	// The exit budget is finite and shared with the HTTP server. A panel that
	// stalls spends its own slice of it and no one else's.
	r := newRig(t, map[string][]string{"panel-1": {"c1"}})
	r.reserve("panel-1", "c1", 2*gb, 50*gb)
	r.extender.PanelTimeout = 20 * time.Millisecond
	r.panels["panel-1"].StallNextCall(2 * time.Second)

	started := time.Now()
	report := r.run(t)

	if took := time.Since(started); took > time.Second {
		t.Errorf("the run took %v, want it cut off at its deadline", took)
	}
	if report.Failed != 1 {
		t.Errorf("failed = %d, want 1", report.Failed)
	}
}

func TestAConfigWithNoClientOnThePanelIsSkipped(t *testing.T) {
	// Nothing to write to. Whether that is a client we never created or one
	// renamed away from us is F-027-aa's verdict, not this pass's — and a
	// shutdown is not the moment to start creating clients.
	r := newRig(t, map[string][]string{"panel-1": {"c1"}})
	r.reserve("panel-1", "c1", 2*gb, 50*gb)
	r.reserve("panel-1", "ghost", 2*gb, 50*gb)

	report := r.run(t)

	if report.Checked != 2 || report.Raised != 1 || report.Skipped != 1 {
		t.Errorf("checked/raised/skipped = %d/%d/%d, want 2/1/1", report.Checked, report.Raised, report.Skipped)
	}
}

// blocked is a health tracker that refuses every panel.
type blocked struct{}

func (blocked) Ask(string, time.Time) bool                              { return false }
func (blocked) Observe(context.Context, string, error, time.Time) error { return nil }
