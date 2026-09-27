package converge_test

import (
	"testing"

	"network-service/internal/converge"
	"network-service/internal/driver/fake"
)

// A pass writes by urgency, not by age (F-027-ct). Every write waits on the
// panel's `maxRequestsPerMinute`, and a re-split moves every idle ceiling as
// well as the one that matters: at 100 inbounds, the consuming config written
// last in `createdAt` order waits ~100 s behind 99 idle shrinks, cut at its old
// ceiling the whole time. So the config closest to crossing the figure that
// matters — the cut it faces, or the share it must not pass — goes first, and
// a config with no rate goes last, in the order it was read.

// writtenOrder is the configs in the order the pass wrote them: a finding is
// appended as its write returns.
func writtenOrder(report converge.Report) []string {
	var order []string
	for _, f := range report.Findings {
		order = append(order, f.ConfigID)
	}
	return order
}

// Shrinks go first (F-027-db): the planner grows a share only from what is
// already free and frees a shrunk one only once its panel confirms it, so a
// shrink queued behind a grow holds the next grow back a whole turn. Among
// the shrinks and among the grows, the order above stands.
func TestAShrinkIsWrittenBeforeAGrow(t *testing.T) {
	r := newRig(t, fake.Config{}, "idle-1", "idle-2", "hot")
	for _, id := range []string{"idle-1", "idle-2", "hot"} {
		r.allocateAt(id, 10*gb, 0)
	}
	r.pass(t) // every panel holds 10 GB

	// The re-split: the consuming config's share rises, the idle two shrink.
	r.panel.Serve("hot", 0, 9*gb+gb/2) // 0.5 GB from its old cut, 20 s at 25 MB/s
	r.allocateAt("idle-1", 5*gb, 0)
	r.allocateAt("idle-2", 5*gb, 0)
	r.allocateAt("hot", 20*gb, mbps200)

	report := r.pass(t)

	order := writtenOrder(report)
	want := []string{"config-idle-1", "config-idle-2", "config-hot"}
	if len(order) != len(want) {
		t.Fatalf("wrote %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("wrote in the order %v, want %v: the shrinks first, in the order read, then the grow", order, want)
		}
	}
}

// A lowering on a moving config is money: past the new share before it is
// written is traffic billed by nobody. It goes ahead of a raise with an hour
// of headroom, and both ahead of an idle config.
func TestTheNearestCrossingIsWrittenFirst(t *testing.T) {
	r := newRig(t, fake.Config{}, "idle", "slow-raise", "lowering")
	for _, id := range []string{"idle", "slow-raise", "lowering"} {
		r.allocateAt(id, 100*gb, 0)
	}
	r.pass(t)

	r.panel.Serve("lowering", 0, 5*gb)
	r.allocateAt("idle", 200*gb, 0)
	r.allocateAt("slow-raise", 200*gb, mbps200) // 100 GB left at 25 MB/s: ~67 min
	r.allocateAt("lowering", 10*gb, mbps200)    // 5 GB left at 25 MB/s: 200 s

	report := r.pass(t)

	order := writtenOrder(report)
	want := []string{"config-lowering", "config-slow-raise", "config-idle"}
	if len(order) != len(want) {
		t.Fatalf("wrote %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("wrote in the order %v, want %v", order, want)
		}
	}
}
