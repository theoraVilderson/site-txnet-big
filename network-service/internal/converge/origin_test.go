package converge_test

import (
	"context"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/converge"
	"network-service/internal/driver"
)

// A User Manager limit counts from the profile link, not the user's life
// (contract.usermanager.md rule 9), so a reading names the link as its limit's
// origin (F-027-du-b). A link made again starts the limit's count at zero
// while the lifetime total goes on: billing must not see a reset, and the
// ceiling must stop counting the old link's bytes as headroom.
func TestANewLimitOriginRebasesTheCeilingAndNeverTheBill(t *testing.T) {
	const remote = "u1"
	cursors := collect.NewMemoryCursors()
	p := collect.Panel{
		ID: "panel-um", CounterSemantics: driver.CounterCumulative,
		Configs: map[string]collect.ConfigRef{remote: {ConfigID: "config-u1", Protocol: "pppoe"}},
	}
	t0 := time.Date(2026, 10, 23, 9, 0, 0, 0, time.UTC)
	pass := func(at time.Time, total int64, origin string) collect.Result {
		t.Helper()
		reading := driver.ClientUsage{RemoteID: remote, DownBytes: total, ObservedAt: at, LimitOrigin: origin}
		res := collect.Normaliser{Panel: p, Cursors: cursors, MinWindow: time.Minute}.Pass([]driver.ClientUsage{reading}, at)
		if err := cursors.Apply(context.Background(), res); err != nil {
			t.Fatalf("Apply: %v", err)
		}
		return res
	}

	// Adopted at 600 MB on link *7: the limit has counted nothing of ours yet.
	pass(t0, 600*mb, "*7")
	if off := converge.OffsetBytes(cursors, p, remote); off != 0 {
		t.Fatalf("offset at adoption = %d, want 0", off)
	}
	// 100 MB more under the same link: billed, and counted by the limit.
	res := pass(t0.Add(time.Minute), 700*mb, "*7")
	if len(res.Deltas) != 1 || res.Deltas[0].DownBytes != 100*mb {
		t.Fatalf("deltas = %+v, want 100 MB", res.Deltas)
	}
	if off := converge.OffsetBytes(cursors, p, remote); off != 0 {
		t.Fatalf("offset under the same link = %d, want 0", off)
	}

	// The link is made again (*9): 50 MB more on the lifetime total, which
	// the new link has counted, if anything, only since it was made.
	at := t0.Add(2 * time.Minute)
	res = pass(at, 750*mb, "*9")
	if len(res.Deltas) != 1 || res.Deltas[0].DownBytes != 50*mb || res.Deltas[0].AfterReset {
		t.Fatalf("deltas = %+v, want 50 MB and no reset: the lifetime total did not go back", res.Deltas)
	}
	cur, _ := cursors.Counter(p.ID, remote)
	if !cur.LastResetAt.IsZero() || cur.ResetCount != 0 {
		t.Fatalf("cursor = %+v: a new link is no reset, or many at once would read as a mass restore", cur)
	}
	if !collect.Restated(cur, at) {
		t.Fatal("the pass that saw the new link does not restate the ceiling")
	}
	// Our 150 MB are all outside the new link's count: none of it is headroom.
	if off := converge.OffsetBytes(cursors, p, remote); off != 150*mb {
		t.Fatalf("offset after the new link = %d, want 150 MB", off)
	}
	if got := converge.PanelCeiling(1000*mb, converge.OffsetBytes(cursors, p, remote)); got != 850*mb {
		t.Fatalf("ceiling = %d, want 850 MB: what is left of the allocation, not the whole of it again", got)
	}

	// A reading that names no origin (a family with none) leaves it.
	pass(t0.Add(3*time.Minute), 760*mb, "")
	if cur, _ := cursors.Counter(p.ID, remote); cur.LimitOriginID != "*9" || cur.LimitOriginBytes != 750*mb {
		t.Fatalf("cursor = %+v, want the origin kept", cur)
	}
	if collect.Restated(cur, t0.Add(3*time.Minute)) {
		t.Fatal("a pass with no new origin restates the ceiling")
	}
}
