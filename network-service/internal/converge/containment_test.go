package converge_test

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/converge"
	"network-service/internal/driver/fake"
)

// Drift containment (F-027-ab), through the collection loop like the drift
// verdicts it bounds: a repair is counted on the pass that makes it, and a
// panel-wide reset has to be caught before the pass publishes, which only the
// loop can show.

// keptSink keeps every published pass, so a test can see what was charged.
type keptSink struct {
	mu     sync.Mutex
	passes []collect.Result
}

func (s *keptSink) Publish(_ context.Context, res collect.Result) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.passes = append(s.passes, res)
	return nil
}

func (s *keptSink) last(t *testing.T) collect.Result {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.passes) == 0 {
		t.Fatal("nothing was published")
	}
	return s.passes[len(s.passes)-1]
}

// containRig is the drift rig with a clock the test moves and the panel-wide
// stop wired in.
type containRig struct {
	*driftRig
	at     time.Time
	sink   *keptSink
	events *collect.MemoryDriftEvents
}

func newContainRig(t *testing.T) *containRig {
	t.Helper()
	r := &containRig{
		driftRig: newDriftRig(t, fake.Config{}),
		at:       time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC),
		sink:     &keptSink{},
		events:   collect.NewMemoryDriftEvents(),
	}
	r.loop.Clock = func() time.Time { return r.at }
	r.loop.Sink = r.sink
	r.loop.Containment = &collect.Containment{Events: r.events}
	return r
}

// pass is one bulk pass a minute after the last.
func (r *containRig) pass(t *testing.T) converge.ConvergeReport {
	t.Helper()
	r.at = r.at.Add(time.Minute)
	return r.driftRig.pass(t)
}

func (r *containRig) row(t *testing.T, configID string) converge.DesiredConfig {
	t.Helper()
	row, ok := r.desired.Get(configID)
	if !ok {
		t.Fatalf("no desired row %s", configID)
	}
	return row
}

// many puts n configs on the panel and runs them to `complete`.
func (r *containRig) many(t *testing.T, n int) []string {
	t.Helper()
	ids := make([]string, n)
	for i := range ids {
		ids[i] = fmt.Sprintf("c%d", i+1)
		r.desired.Put("panel-1", wanted(ids[i]))
	}
	r.pass(t)
	r.pass(t)
	remote := make([]string, n)
	for i, id := range ids {
		row := r.row(t, id)
		if row.State != converge.StateComplete || row.RemoteID == "" {
			t.Fatalf("setup: %s = %+v, want complete", id, row)
		}
		remote[i] = row.RemoteID
	}
	return remote
}

func (r *containRig) lower(t *testing.T, remoteID string, to int64) {
	t.Helper()
	if err := r.panel.SetClientDataLimit(context.Background(), remoteID, to); err != nil {
		t.Fatalf("operator write: %v", err)
	}
}

// ---- the anti-flap stop -----------------------------------------------------

func TestAMissingClientIsRecreatedAndThatIsARepair(t *testing.T) {
	r := newContainRig(t)
	r.established(t)

	r.panel.Remove("remote-1")
	r.pass(t)

	row := r.drift(t, converge.DriftMissing)
	if got := r.panel.CallCount("CreateClient"); got != 2 {
		t.Fatalf("CreateClient called %d times, want the one recreate", got)
	}
	if row.RemoteID == "remote-1" || row.RemoteID == "" {
		t.Fatalf("remoteId = %q, want the recreated client's", row.RemoteID)
	}
	if row.RepairCount != 1 || !row.RepairedAt.Equal(r.at) {
		t.Fatalf("repairs = %d at %v, want 1 at %v", row.RepairCount, row.RepairedAt, r.at)
	}
}

func TestTheThirdRepairInsideTheWindowIsHeldAndTheConfigIsContested(t *testing.T) {
	r := newContainRig(t)
	r.established(t)

	for i := 0; i < converge.MaxRepairs; i++ {
		r.panel.Remove(r.row(t, "c1").RemoteID)
		r.pass(t) // recreated
		r.pass(t) // confirmed
	}
	if got := r.panel.CallCount("CreateClient"); got != 1+converge.MaxRepairs {
		t.Fatalf("setup: CreateClient called %d times", got)
	}

	r.panel.Remove(r.row(t, "c1").RemoteID)
	report := r.pass(t)

	r.drift(t, converge.DriftContested)
	if got := r.panel.CallCount("CreateClient"); got != 1+converge.MaxRepairs {
		t.Fatalf("CreateClient called %d times: a third repair inside the window is the flapping the stop exists for", got)
	}
	if onlyAction(t, report.Provisioning, converge.ActionContested).Err != nil {
		t.Fatal("a held repair is not a refused write")
	}

	// The window is 24 hours from the last repair, not a life sentence: the
	// same drift a day later is a new dispute and is repaired.
	r.at = r.at.Add(converge.RepairWindow)
	r.pass(t)

	row := r.drift(t, converge.DriftMissing)
	if got := r.panel.CallCount("CreateClient"); got != 2+converge.MaxRepairs {
		t.Fatalf("CreateClient called %d times, want the repair once the window ran out", got)
	}
	if row.RepairCount != 1 {
		t.Fatalf("repairs = %d, want the count started again", row.RepairCount)
	}
}

func TestACeilingSetAboveOursIsRewrittenEvenOnAContestedConfig(t *testing.T) {
	r := newContainRig(t)
	r.established(t)
	r.pass(t) // the 10 GB it was created under is confirmed

	for i := 0; i < converge.MaxRepairs; i++ {
		r.lower(t, "remote-1", 1*gb)
		r.pass(t) // raised back: a repair
		r.pass(t) // confirmed
	}
	r.lower(t, "remote-1", 1*gb)
	r.pass(t)

	r.drift(t, converge.DriftContested)
	if got := r.enforcing(t, "remote-1"); got != 1*gb {
		t.Fatalf("enforcing %d, want their 1 GB held: raising it a third time is the flap", got)
	}

	// A higher ceiling is a money hole, not a dispute: rewritten whatever the
	// count says, and never counted as a repair.
	r.lower(t, "remote-1", 500*gb)
	r.pass(t)

	row := r.drift(t, converge.DriftLimitOverridden)
	if got := r.enforcing(t, "remote-1"); got != 10*gb {
		t.Fatalf("enforcing %d, want our 10 GB: a ceiling above ours is served against nobody's purchase", got)
	}
	if row.RepairCount != converge.MaxRepairs {
		t.Fatalf("repairs = %d, want %d: the exception is not a repair", row.RepairCount, converge.MaxRepairs)
	}
}

func (r *containRig) enforcing(t *testing.T, remoteID string) int64 {
	t.Helper()
	for _, c := range r.clients(t) {
		if c.RemoteID == remoteID {
			return c.DataLimitBytes
		}
	}
	t.Fatalf("no client %s", remoteID)
	return 0
}

// ---- the panel-wide event ---------------------------------------------------

func TestAPanelWhoseCountersGoBackwardTogetherHaltsAndChargesNothing(t *testing.T) {
	r := newContainRig(t)
	remote := r.many(t, 10)
	for _, id := range remote {
		r.panel.Serve(id, 0, 1*gb)
	}
	r.pass(t)
	r.panel.TakeBackup()
	for _, id := range remote {
		r.panel.Serve(id, 0, 1*gb)
	}
	r.pass(t)

	r.panel.RestoreBackup() // every counter back to 1 GB, from 2 GB billed
	r.pass(t)

	events := r.events.Events("panel-1")
	if len(events) != 1 || events[0].Type != collect.MassReset ||
		events[0].Affected != 10 || events[0].Observed != 10 || !events[0].CollectionHalted {
		t.Fatalf("events = %+v, want one halting mass_reset over 10 of 10", events)
	}
	res := r.sink.last(t)
	for _, d := range res.Deltas {
		if d.AfterReset {
			t.Fatalf("published %+v: a restore's resets are thousands of plausible wrong charges", d)
		}
	}
	if len(res.Quarantines) != 10 {
		t.Fatalf("quarantines = %d, want all 10 resets parked, not dropped", len(res.Quarantines))
	}
	for _, q := range res.Quarantines {
		if q.Reason != collect.ReasonPanelDriftEvent || q.DownBytes != 1*gb {
			t.Fatalf("quarantine = %+v, want the restored 1 GB under panel_drift_event", q)
		}
	}
	// The ceiling is restated over the restored counter, and the parked bytes
	// are not counted as served: 2 GB billed, the counter reads 1 GB, so the
	// panel may count to 9 GB.
	if got := r.enforcing(t, remote[0]); got != 9*gb {
		t.Fatalf("enforcing %d, want 9 GB in the same pass", got)
	}

	// Halted: not read again until somebody decides, but still enforced.
	reads, lists := r.panel.CallCount("GetUsage"), r.panel.CallCount("ListClients")
	r.at = r.at.Add(time.Minute)
	report, err := r.loop.Pass(context.Background())
	if err != nil {
		t.Fatalf("pass: %v", err)
	}
	if len(report.Failed) != 1 || report.Failed[0].Op != collect.OpHalted {
		t.Fatalf("failed = %+v, want the halted panel reported, not silent", report.Failed)
	}
	if r.panel.CallCount("GetUsage") != reads {
		t.Fatal("a halted panel was read")
	}
	if r.panel.CallCount("ListClients") != lists+1 {
		t.Fatal("a halted panel was not converged: a suspension must still reach it")
	}

	r.events.Acknowledge("panel-1", r.at)
	for _, id := range remote {
		r.panel.Serve(id, 0, 1*gb)
	}
	r.pass(t)
	if got := r.sink.last(t).Deltas; len(got) != 10 || got[0].AfterReset || got[0].DownBytes != 1*gb {
		t.Fatalf("deltas after the acknowledgement = %+v, want the new 1 GB each, billed", got)
	}
	if len(r.events.Events("panel-1")) != 1 {
		t.Fatal("the acknowledged restore was raised again")
	}
}

func TestAFewResetsOnAPanelAreOrdinaryResets(t *testing.T) {
	for _, tc := range []struct {
		name          string
		configs, zero int
	}{
		{"exactly the share is not more than it", 10, 2},
		{"a small panel under the floor", 4, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newContainRig(t)
			remote := r.many(t, tc.configs)
			for _, id := range remote {
				r.panel.Serve(id, 0, 1*gb)
			}
			r.pass(t)
			for _, id := range remote[:tc.zero] {
				r.panel.ZeroCounter(id)
				r.panel.Serve(id, 0, gb/2) // below the last read: a reset
			}
			r.pass(t)

			if got := r.events.Events("panel-1"); len(got) != 0 {
				t.Fatalf("events = %+v, want none", got)
			}
			resets := 0
			for _, d := range r.sink.last(t).Deltas {
				if d.AfterReset {
					resets++
				}
			}
			if resets != tc.zero {
				t.Fatalf("published %d post-reset deltas, want %d billed as ordinary resets", resets, tc.zero)
			}
		})
	}
}
