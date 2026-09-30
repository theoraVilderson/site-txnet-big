package leaseplan_test

import (
	"testing"
	"time"

	"network-service/internal/lease/quota"
	"network-service/internal/leaseplan"
)

// Close by disable (F-027-dd, SPEC §6-2): a Grant the planner closes is
// written `enable=false` on every config — not only a ceiling at the counter,
// which the panel enforces a tick late — and the close is kept on
// `network.lease_close`, so a restart does not reopen it. A renewal — Quota
// or the end moved since the close — with at least ReopenMin available opens
// it again.
func TestAClosedGrantIsDisabledAndReopensOnARenewal(t *testing.T) {
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

// An end that passes on a Grant already closed on its bytes moves the close
// to that end (F-027-dy): the row changes, so the close is announced again
// and billing reads it as `period_ended`. Seen live on 2026-09-30: an admin
// ended a Grant closed on its bytes, and it read `active` with no purge clock.
func TestAnEndPassingOnAClosedGrantMovesTheClose(t *testing.T) {
	b := newBench(t, 64*quota.MB, "a", "b")
	end := b.at.Add(30 * 24 * time.Hour)
	b.s.grants[0].ExpiresAt = end
	for i := 0; i < 60 && b.s.closure("grant-1") == nil; i++ {
		b.turn(map[string]int64{"a": 20 * quota.MB, "b": 20 * quota.MB})
	}
	c := b.s.closure("grant-1")
	if c == nil || !c.ExpiresAt.Equal(end) {
		t.Fatalf("a spent bag closes on the end it had: %+v", c)
	}

	// The end is moved into the past: the close moves to it.
	past := b.at.Add(-time.Minute)
	b.s.grants[0].ExpiresAt = past
	b.turn(nil)
	if c = b.s.closure("grant-1"); c == nil || !c.ExpiresAt.Equal(past) || c.Quota != 64*quota.MB {
		t.Fatalf("an end that passed on a closed Grant moves its close to that end: %+v", c)
	}

}

// A close taken with bytes left reopens on its own (F-027-dx, rule 25): two
// configs at 20 MB a turn run dry on a 64 MB bag with bytes still paid, which
// is the blocked branch, not a spent one. Once every write has landed and Used
// stands still, the rest is enough to finish on, and the planner enables a
// config again with no renewal. Seen live on 2026-09-30: 464 MB paid, closed.
func TestACloseWithBytesLeftReopensOnceItSettles(t *testing.T) {
	b := newBench(t, 64*quota.MB, "a", "b")
	for i := 0; i < 60 && b.s.closure("grant-1") == nil; i++ {
		b.turn(map[string]int64{"a": 20 * quota.MB, "b": 20 * quota.MB})
	}
	c := b.s.closure("grant-1")
	if c == nil {
		t.Fatal("the bag was never closed")
	}
	left := b.s.grants[0].Quota - b.s.grants[0].Used
	if left < 8*quota.MB {
		t.Fatalf("closed with %d MiB left; the bench must close on the blocked branch", left/quota.MB)
	}

	for i := 0; i < 20 && b.s.closure("grant-1") != nil; i++ {
		b.turn(nil)
	}
	if b.s.closure("grant-1") != nil {
		t.Fatalf("a close with %d MiB left never reopened without a renewal", left/quota.MB)
	}
	pl := b.plans[len(b.plans)-1]
	enabled := false
	for _, a := range pl.Actions {
		enabled = enabled || a.Enable
	}
	if pl.Closed || !enabled {
		t.Fatalf("the reopening plan enabled nothing: %+v", pl)
	}
	if b.s.grants[0].Quota != c.Quota {
		t.Fatal("the bench renewed the bag; this is the no-renewal path")
	}
}
