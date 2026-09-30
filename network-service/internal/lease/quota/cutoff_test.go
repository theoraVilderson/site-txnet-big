package quota

import (
	"testing"
	"time"
)

// Every family with a per-client limit stores a ceiling of 0 as one byte,
// since 0 is "no limit" on its wire (driver.CutOffBytes). A config closed or
// reclaimed at a counter of 0 is written 0 and read back as 1; that byte is
// our 0. Seen live on 2026-09-30 on x-ui: a guard close with an idle config
// never settled, and a prepaid Grant stayed off with 57 MB paid.

func TestACutOffReadBackAsOneByteHasLanded(t *testing.T) {
	r := &Replica{Exists: true, LimitWant: 0, WantEnabled: false}
	if !r.landed(CutOffBytes, false, 0) {
		t.Fatal("a cut-off the panel holds as one byte has not landed")
	}
	r = &Replica{Exists: true, LimitWant: 0, WantEnabled: true}
	if !r.landed(CutOffBytes, true, 0) {
		t.Fatal("an idle reclaim to 0 the panel holds as one byte has not landed")
	}
	r = &Replica{Exists: true, LimitWant: 5 * MB, WantEnabled: true}
	if r.landed(CutOffBytes, true, 0) {
		t.Fatal("one byte is the cut-off only; it is not a 5 MB ceiling")
	}
}

func TestAGuardCloseWithAnIdleConfigSettlesOnTheCutOffByte(t *testing.T) {
	t0 := time.Date(2026, 9, 30, 8, 49, 11, 0, time.UTC)
	idle := &Replica{Exists: true, Counter: 0, LimitWant: 0, LimitSeen: CutOffBytes, effAt: t0.Add(time.Minute)}
	busy := &Replica{Exists: true, Counter: 50 * MB, LimitWant: 50 * MB, LimitSeen: 50 * MB, effAt: t0.Add(time.Minute)}
	a := &Account{Used: 50 * MB, closeWatched: true, closedUsed: 50 * MB, closedAt: t0, closedWhy: CloseGuard}

	if !a.settled([]*view{{r: idle}, {r: busy}}) {
		t.Fatal("a guard close whose idle config reads back the cut-off byte never settles")
	}
}
