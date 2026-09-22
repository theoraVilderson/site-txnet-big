package hot_test

import (
	"context"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
	"network-service/internal/hot"
)

const (
	gb      = int64(1) << 30
	mb      = int64(1) << 20
	gigabit = int64(1_000_000_000)
)

// ---- harness ---------------------------------------------------------------

type recorder struct {
	results []collect.Result
	calls   int
}

func (r *recorder) Publish(_ context.Context, res collect.Result) error {
	r.calls++
	r.results = append(r.results, res)
	return nil
}

func (r *recorder) last(t *testing.T) collect.Result {
	t.Helper()
	if len(r.results) == 0 {
		t.Fatal("nothing was published")
	}
	return r.results[len(r.results)-1]
}

type rig struct {
	panel   *fake.Panel
	loop    *hot.Loop
	sink    *recorder
	cursors *collect.MemoryCursors
	cands   []hot.Candidate
}

// newRig puts `clients` on one fake panel and hands the loop a candidate for
// each, so a test says only what makes one of them hot.
func newRig(t *testing.T, clients ...string) *rig {
	t.Helper()
	p := fake.New(fake.Config{CounterSemantics: driver.CounterCumulative})
	configs := map[string]collect.ConfigRef{}
	for _, id := range clients {
		p.Given(id)
		configs[id] = collect.ConfigRef{ConfigID: "config-" + id, Protocol: "vless"}
	}
	panel := collect.Panel{
		ID:               "panel-1",
		CounterSemantics: driver.CounterCumulative,
		Transport:        driver.TransportPull,
		MaxLineRateBps:   gigabit,
		Driver:           p,
		Configs:          configs,
	}

	r := &rig{panel: p, sink: &recorder{}, cursors: collect.NewMemoryCursors()}
	for _, id := range clients {
		r.cands = append(r.cands, hot.Candidate{
			Panel: panel, ConfigID: "config-" + id, RemoteID: id,
			HeadroomBytes: 500 * gb, RateBps: 0,
		})
	}
	r.loop = &hot.Loop{
		Source:  hot.CandidatesFunc(func(context.Context) ([]hot.Candidate, error) { return r.cands, nil }),
		Sink:    r.sink,
		Cursors: r.cursors,
	}
	return r
}

func (r *rig) pass(t *testing.T) hot.PassReport {
	t.Helper()
	report, err := r.loop.Pass(context.Background())
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	return report
}

// hot makes the candidate for `remoteID` near its ceiling: `seconds` of
// headroom left at `rateBps`.
func (r *rig) hot(remoteID string, rateBps int64, seconds int64) {
	for i := range r.cands {
		if r.cands[i].RemoteID == remoteID {
			r.cands[i].RateBps = rateBps
			r.cands[i].HeadroomBytes = rateBps / 8 * seconds
		}
	}
}

// ---- the figures the row names ---------------------------------------------

func TestIntervalBoundsAreTheDeclaredOnes(t *testing.T) {
	if hot.MinInterval != 2*time.Second {
		t.Errorf("min interval = %v, want 2s", hot.MinInterval)
	}
	if hot.MaxInterval != 60*time.Second {
		t.Errorf("max interval = %v, want 60s", hot.MaxInterval)
	}
	if hot.MaxInterval != collect.DefaultInterval {
		t.Errorf("max interval = %v, want the bulk pass's %v: slower than the bulk pass is not a hot loop", hot.MaxInterval, collect.DefaultInterval)
	}
}

// ---- membership is time to ceiling, never bytes -----------------------------

func TestAGigabitUserIsHotOnHeadroomAOneMegabitUserIsNot(t *testing.T) {
	// The same 6 GB of headroom: 53s at a gigabit, 13 hours at a megabit.
	// Membership is in seconds, so no speed is "too fast" (ADR-0072).
	fast := hot.Candidate{RateBps: gigabit, HeadroomBytes: 6 * gb}
	slow := hot.Candidate{RateBps: 1_000_000, HeadroomBytes: 6 * gb}

	if got := hot.TimeToCeiling(fast); got > 60*time.Second {
		t.Errorf("gigabit time to ceiling = %v, want under a minute", got)
	}
	if !hot.IsHot(fast, hot.DefaultHorizon) {
		t.Error("a gigabit user 53s from their ceiling is not hot")
	}
	if hot.IsHot(slow, hot.DefaultHorizon) {
		t.Errorf("a megabit user %v from their ceiling is hot", hot.TimeToCeiling(slow))
	}
}

func TestNoHeadroomIsHotAtAnySpeedAndAnUnmeasurableConfigIsNot(t *testing.T) {
	spent := hot.Candidate{RateBps: 0, HeadroomBytes: 0}
	if hot.TimeToCeiling(spent) != 0 {
		t.Error("a spent allowance is not at zero time to ceiling")
	}
	if !hot.IsHot(spent, hot.DefaultHorizon) {
		t.Error("a config with nothing left is not hot")
	}

	// Never measured and the panel declares no line rate: zero is unknown,
	// not zero (`Panel.MaxLineRateBps`), so there is no time to ceiling to
	// judge and the bulk pass keeps it.
	unknown := hot.Candidate{RateBps: 0, HeadroomBytes: 6 * gb}
	if hot.IsHot(unknown, hot.DefaultHorizon) {
		t.Error("a config with no measured rate and no declared line rate is hot")
	}
}

func TestAConfigNeverMeasuredIsJudgedAtTheLineRate(t *testing.T) {
	// The first horizon is the panel's own line rate: until a pass has
	// measured this config, the safe assumption is that it is at line speed.
	first := hot.Candidate{
		Panel:         collect.Panel{MaxLineRateBps: gigabit},
		RateBps:       0,
		HeadroomBytes: 6 * gb,
	}
	if !hot.IsHot(first, hot.DefaultHorizon) {
		t.Error("a config never measured on a gigabit panel is not hot")
	}
	if got, want := hot.TimeToCeiling(first), hot.TimeToCeiling(hot.Candidate{RateBps: gigabit, HeadroomBytes: 6 * gb}); got != want {
		t.Errorf("first time to ceiling = %v, want the line rate's %v", got, want)
	}
}

// ---- the interval tunes itself off the nearest ceiling ----------------------

func TestIntervalIsTheNearestCeilingQuarteredAndClamped(t *testing.T) {
	cases := []struct {
		name    string
		seconds int64
		want    time.Duration
	}{
		{"a minute out is a quarter of it", 60, 15 * time.Second},
		{"two minutes out is capped by the horizon, not by the clamp", 120, 30 * time.Second},
		{"four seconds out clamps at the floor", 4, hot.MinInterval},
		{"nothing left clamps at the floor", 0, hot.MinInterval},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := hot.Interval([]hot.Candidate{{RateBps: gigabit, HeadroomBytes: gigabit / 8 * c.seconds}})
			if got != c.want {
				t.Errorf("interval = %v, want %v", got, c.want)
			}
		})
	}
}

func TestTheIntervalIsTheNearestCeilingsNotTheAverage(t *testing.T) {
	members := []hot.Candidate{
		{RateBps: gigabit, HeadroomBytes: gigabit / 8 * 120},
		{RateBps: gigabit, HeadroomBytes: gigabit / 8 * 20},
	}
	if got, want := hot.Interval(members), 5*time.Second; got != want {
		t.Errorf("interval = %v, want %v — the loop runs for the config closest to its ceiling", got, want)
	}
}

func TestAnEmptyHotSetFallsBackToTheBulkInterval(t *testing.T) {
	if got := hot.Interval(nil); got != hot.MaxInterval {
		t.Errorf("interval = %v, want %v with nobody hot", got, hot.MaxInterval)
	}
}

// ---- the pass: the hot few, one request per panel ---------------------------

func TestTheHotPassReadsOnlyTheHotConfigsAndCostsOneRequest(t *testing.T) {
	r := newRig(t, "c1", "c2", "c3")
	r.hot("c2", gigabit, 30)

	report := r.pass(t)

	if report.Members != 1 {
		t.Fatalf("members = %d, want 1: only c2 is near its ceiling", report.Members)
	}
	if got := r.panel.CallCount("GetUsageFor"); got != 1 {
		t.Errorf("GetUsageFor called %d times, want 1 for the whole panel (invariant 34)", got)
	}
	if got := r.panel.CallCount("GetUsage"); got != 0 {
		t.Errorf("the hot pass made %d bulk reads, want 0: the point is not to pass over all 5000", got)
	}
	res := r.sink.last(t)
	if len(res.Advances) != 1 || res.Advances[0].RemoteID != "c2" {
		t.Errorf("advances = %+v, want c2's alone", res.Advances)
	}
}

func TestNobodyHotIsNoRequestAtAll(t *testing.T) {
	r := newRig(t, "c1")

	report := r.pass(t)

	if report.Members != 0 || report.Panels != 0 {
		t.Errorf("report = %+v, want an empty pass", report)
	}
	if r.panel.TotalCalls() != 0 {
		t.Errorf("%d calls made with nobody hot, want 0", r.panel.TotalCalls())
	}
	if r.sink.calls != 0 {
		t.Errorf("%d publishes with nothing read, want 0", r.sink.calls)
	}
}

func TestTheHotPassPublishesTheSameDeltaStreamAsTheBulkOne(t *testing.T) {
	r := newRig(t, "c1")
	r.hot("c1", gigabit, 30)

	r.pass(t) // adoption: the first reading is a baseline
	// 128 MB inside the cap's floor of two seconds at a gigabit (250 MB).
	r.panel.Serve("c1", 64*mb, 64*mb)
	r.pass(t)

	res := r.sink.last(t)
	if len(res.Deltas) != 1 {
		t.Fatalf("deltas = %+v, want one", res.Deltas)
	}
	if res.Deltas[0].ConfigID != "config-c1" || res.Deltas[0].UpBytes != 64*mb || res.Deltas[0].DownBytes != 64*mb {
		t.Errorf("delta = %+v, want config-c1 at 64 MB up and down", res.Deltas[0])
	}
}

func TestThePlausibilityCapIsMeasuredOverTheHotIntervalNotTheBulkOne(t *testing.T) {
	// Two gigabytes between two hot passes is a minute of gigabit traffic in
	// the two seconds this loop can run at. Floored at the bulk pass's minute
	// the cap would believe it; floored at MinInterval it does not
	// (`contract.collection.md`, the stretched plausibility cap).
	r := newRig(t, "c1")
	r.hot("c1", gigabit, 30)

	r.pass(t)
	r.panel.Serve("c1", gb, gb)
	r.pass(t)

	res := r.sink.last(t)
	if len(res.Deltas) != 0 {
		t.Errorf("deltas = %+v, want none: the figure is past what two seconds could carry", res.Deltas)
	}
	if len(res.Quarantines) != 1 || res.Quarantines[0].Reason != collect.ReasonImplausibleVolume {
		t.Errorf("quarantines = %+v, want one implausible volume", res.Quarantines)
	}
}

func TestACursorMovesOnlyAfterThePassIsPublished(t *testing.T) {
	r := newRig(t, "c1")
	r.hot("c1", gigabit, 30)
	r.loop.Sink = failingSink{}

	report := r.pass(t)

	if len(report.Failed) != 1 || report.Failed[0].Op != "Publish" {
		t.Fatalf("failures = %+v, want one failed publish", report.Failed)
	}
	if _, seen := r.cursors.Counter("panel-1", "c1"); seen {
		t.Error("the cursor moved on a pass that was never published (invariant 18)")
	}
}

type failingSink struct{}

func (failingSink) Publish(context.Context, collect.Result) error { return context.DeadlineExceeded }
