package leaseplan_test

import (
	"testing"

	"network-service/internal/lease/quota"
	"network-service/internal/leaseplan"
)

// Close by disable (F-027-dd, SPEC §6-2): a Grant the planner closes is
// written `enable=false` on every config — not only a ceiling at the counter,
// which the panel enforces a tick late — and the close is kept on
// `network.lease_close`, so a restart does not reopen it. Only a renewal —
// Quota or the end moved since the close — with at least ReopenMin available
// opens it again.
func TestAClosedGrantIsDisabledAndReopensOnlyOnARenewal(t *testing.T) {
	b := newBench(t, 64*quota.MB, "a", "b")
	for i := 0; i < 60 && b.s.closure("grant-1") == nil; i++ {
		b.turn(map[string]int64{"a": 20 * quota.MB, "b": 20 * quota.MB})
	}
	c := b.s.closure("grant-1")
	if c == nil {
		t.Fatal("a spent bag was never closed")
	}
	if c.Quota != 64*quota.MB {
		t.Fatalf("closed at Quota %d, want the Quota it closed on (%d)", c.Quota, 64*quota.MB)
	}
	closing := b.plans[len(b.plans)-1]
	if !closing.Closed || len(closing.Actions) == 0 {
		t.Fatalf("the closing plan wrote nothing: %+v", closing)
	}
	for _, a := range closing.Actions {
		if a.Enable {
			t.Fatalf("a close left %s enabled: %+v", a.ConfigID, a)
		}
	}

	// A restart: a new process reads the close back and does not reopen.
	b.pl = &leaseplan.Planner{Store: b.s}
	b.turn(nil)
	if b.s.closure("grant-1") == nil || !b.plans[len(b.plans)-1].Closed {
		t.Fatal("a restart reopened a closed Grant")
	}

	// A renewal that leaves less than ReopenMin is not worth reopening for.
	b.s.grants[0].Quota = b.s.grants[0].Used + 4*quota.MB
	if b.s.grants[0].Quota == c.Quota {
		t.Fatal("the bench closed with exactly 4 MB left; the renewal changes nothing")
	}
	b.turn(nil)
	if b.s.closure("grant-1") == nil {
		t.Fatal("reopened with 4 MB left, below ReopenMin")
	}

	// A real one reopens it, and the planner enables a config again.
	b.s.grants[0].Quota += 256 * quota.MB
	b.turn(nil)
	if b.s.closure("grant-1") != nil {
		t.Fatal("a renewal of 256 MB did not reopen the Grant")
	}
	pl := b.plans[len(b.plans)-1]
	enabled := false
	for _, a := range pl.Actions {
		enabled = enabled || a.Enable
	}
	if pl.Closed || !enabled {
		t.Fatalf("the reopening plan enabled nothing: %+v", pl)
	}
}
