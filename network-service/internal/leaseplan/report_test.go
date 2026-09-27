package leaseplan_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"network-service/internal/lease/quota"
	"network-service/internal/leaseplan"
)

// line is one `lease shadow plan` log line as the service's JSON handler
// writes it.
func line(t *testing.T, at time.Time, used int64, closed bool, reps ...leaseplan.ReplicaView) string {
	t.Helper()
	b, err := json.Marshal(map[string]any{
		"time": at.Format(time.RFC3339Nano), "level": "INFO", "msg": "lease shadow plan",
		"panel": "panel-1", "grant": "grant-1", "quota": quota.GB, "used": used,
		"avail": quota.GB - used, "endgame": false, "closed": closed, "actions": 0, "replicas": reps,
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func alloc(v int64) *int64 { return &v }

// Overshoot is what was served past the bag; a false cut is a config that
// could not pass traffic while the Grant still had bytes, counted in seconds
// until the next turn, once for the live ceilings and once for the planner's.
func TestTheReportCountsOvershootAndFalseCutSeconds(t *testing.T) {
	t0 := time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)
	mb := quota.MB
	in := strings.Join([]string{
		"not json: a startup banner",
		`{"time":"2026-09-27T10:00:00Z","level":"INFO","msg":"lease shadow action","grant":"grant-1"}`,
		// c1 is at its live ceiling while 600 MB are left: a live false cut.
		// The planner would give it more; it agrees with the split on c2.
		line(t, t0, 400*mb, false,
			leaseplan.ReplicaView{Config: "c1", Counter: 300 * mb, Seen: 300 * mb, Want: 500 * mb, SeenEnabled: true, WantEnabled: true, Allocated: alloc(300 * mb)},
			leaseplan.ReplicaView{Config: "c2", Counter: 100 * mb, Seen: 700 * mb, Want: 700 * mb, SeenEnabled: true, WantEnabled: true, Allocated: alloc(700 * mb)}),
		// 10 s on: the live split raised c1; the planner now cuts c2 early.
		line(t, t0.Add(10*time.Second), 500*mb, false,
			leaseplan.ReplicaView{Config: "c1", Counter: 400 * mb, Seen: 600 * mb, Want: 600 * mb, SeenEnabled: true, WantEnabled: true, Allocated: alloc(600 * mb)},
			leaseplan.ReplicaView{Config: "c2", Counter: 100 * mb, Seen: 400 * mb, Want: 100 * mb, SeenEnabled: true, WantEnabled: true, Allocated: alloc(400 * mb)}),
		// 20 s on: the bag is passed by 10 MB and both sides disable the
		// configs. A cut past the bag is not false.
		line(t, t0.Add(30*time.Second), quota.GB+10*mb, true,
			leaseplan.ReplicaView{Config: "c1", Counter: quota.GB + 10*mb - 100*mb, Seen: 924 * mb, Want: quota.GB + 10*mb - 100*mb, WantEnabled: false, Allocated: alloc(924 * mb)},
			leaseplan.ReplicaView{Config: "c2", Counter: 100 * mb, Seen: 400 * mb, Want: 100 * mb, WantEnabled: false, Allocated: alloc(400 * mb)}),
	}, "\n")

	rep, err := leaseplan.ReadReport(strings.NewReader(in))
	if err != nil {
		t.Fatalf("ReadReport: %v", err)
	}
	if len(rep.Grants) != 1 {
		t.Fatalf("want one Grant, got %d", len(rep.Grants))
	}
	g := rep.Grants[0]
	if g.Turns != 3 || g.Quota != quota.GB || g.Used != quota.GB+10*mb {
		t.Fatalf("turns/quota/used = %d/%d/%d", g.Turns, g.Quota, g.Used)
	}
	if g.Overshoot != 10*mb {
		t.Errorf("overshoot = %d, want 10 MB", g.Overshoot)
	}
	if g.LiveFalseCut != 10*time.Second {
		t.Errorf("live false cut = %v, want 10s (c1 at its ceiling, turn 1)", g.LiveFalseCut)
	}
	if g.PlannerFalseCut != 20*time.Second {
		t.Errorf("planner false cut = %v, want 20s (c2 at its want, turn 2)", g.PlannerFalseCut)
	}
	// Turn 2: the planner is 300 MB off the split on c2. Turn 3 is past the
	// bag, where the split no longer means anything.
	if want := float64(300*mb) / float64(quota.GB); g.MaxDivergence != want {
		t.Errorf("max divergence = %v, want %v", g.MaxDivergence, want)
	}
	// Committed is Used plus every enabled config's room under its ceiling.
	// Turn 1: the planner 400 + (200 + 600) MB, past the bag by 176 MB. The
	// live ceilings stay under it until turn 3, where Used alone is 10 MB over.
	if want := 400*mb + 200*mb + 600*mb - quota.GB; g.PlannerCommitOver != want {
		t.Errorf("planner commit over = %d, want %d", g.PlannerCommitOver, want)
	}
	if want := 10 * mb; g.LiveCommitOver != want {
		t.Errorf("live commit over = %d, want %d", g.LiveCommitOver, want)
	}
	if !g.Closed {
		t.Error("the planner closed the Grant on the last turn")
	}
}

// A gap longer than MaxTurnGap is the service being down, not a cut that
// lasted: nothing is counted across it.
func TestAGapInTheLogIsNotCounted(t *testing.T) {
	t0 := time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)
	cut := leaseplan.ReplicaView{Config: "c1", Counter: 300 * quota.MB, Seen: 300 * quota.MB, Want: 300 * quota.MB, SeenEnabled: true, WantEnabled: true}
	in := line(t, t0, 300*quota.MB, false, cut) + "\n" +
		line(t, t0.Add(leaseplan.MaxTurnGap+time.Second), 300*quota.MB, false, cut)
	rep, err := leaseplan.ReadReport(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	if g := rep.Grants[0]; g.LiveFalseCut != 0 || g.PlannerFalseCut != 0 {
		t.Errorf("false cut across a gap: live %v, planner %v", g.LiveFalseCut, g.PlannerFalseCut)
	}
}
