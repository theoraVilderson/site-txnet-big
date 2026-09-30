package leaseplan_test

import (
	"testing"
	"time"

	"network-service/internal/lease/quota"
	"network-service/internal/leaseplan"
)

// lateBag is a panel that serves ~35 s past a ceiling (x-ui, measured live
// 2026-09-30) on a 5 s tick, and one Grant on it whose config is idle with a
// ceiling the store says it holds.
func lateBag(bag int64) *leaseplan.Planner {
	s := ticked()
	pn := s.panels[panelID]
	pn.Learned.LagMeanSec, pn.Learned.LagSamples = 35, 3
	s.panels[panelID] = pn
	idle := moving(0)
	idle.LimitSeen = bag / 2
	s.set(0, idle)
	s.grants[0].Quota = bag
	return &leaseplan.Planner{Store: s}
}

// idleReads reads the config at a standstill on three ticks, each read a
// quarter second past its PollGuard (the poller's sweep), and returns the last.
func idleReads(t *testing.T, s *leaseplan.Planner) time.Time {
	t.Helper()
	var last time.Time
	for i := range 3 {
		last = pollT0.Add(time.Duration(i)*pollJ + phase0 + leaseplan.PollGuard + 250*time.Millisecond)
		read(t, s, last)
	}
	return last
}

// A bag the panel's lag would outrun is read every tick (F-027-ed). Live,
// a 51 MB bag on an idle config was read every 20 s (IdleMinPoll) and a
// burst at ~36 MB/s was served 34.8 MB past it before the next read closed
// it; every read in the endgame came two ticks apart, since a read a few ms
// past its slot put the next tick inside MinPoll of it.
func TestABagThePanelsLagWouldOutrunIsReadEveryTick(t *testing.T) {
	s := lateBag(51 * quota.MB)
	last := idleReads(t, s)

	next, ok := s.NextPoll(panelID, 4*time.Second)
	if !ok {
		t.Fatal("no poll planned for a Grant near its end")
	}
	if got, want := next.Sub(last), pollJ-250*time.Millisecond; got != want {
		t.Fatalf("next read is %v after the last, want the next tick's (%v)", got, want)
	}
}

// A bag the panel's own ceiling still holds is not: an idle config on 50 GB
// keeps the idle cadence, so a panel is not read every tick for every Grant.
func TestABigBagKeepsTheIdleCadence(t *testing.T) {
	s := lateBag(50 * quota.GB)
	last := idleReads(t, s)

	next, _ := s.NextPoll(panelID, 4*time.Second)
	if gap := next.Sub(last); gap < quota.DefaultParams().IdleMinPoll-pollJ {
		t.Fatalf("an idle 50 GB bag is read %v after the last read", gap)
	}
}

// The panel's budget is still counted from the read itself: a panel that
// allows one poll per 5 s is not read 4.75 s after the last.
func TestTheBudgetIsCountedFromTheReadNotItsTick(t *testing.T) {
	s := lateBag(51 * quota.MB)
	last := idleReads(t, s)

	next, _ := s.NextPoll(panelID, pollJ)
	if next.Sub(last) < pollJ {
		t.Fatalf("next read is %v after the last, inside the panel's budget of %v", next.Sub(last), pollJ)
	}
	if got := sinceTick(next); got != leaseplan.PollGuard {
		t.Fatalf("next read is %v past a tick, want %v", got, leaseplan.PollGuard)
	}
}
