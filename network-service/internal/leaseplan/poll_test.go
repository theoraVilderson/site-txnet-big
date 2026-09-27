package leaseplan_test

import (
	"context"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
	"network-service/internal/lease/quota"
	"network-service/internal/leaseplan"
)

// The panel's tick, pinned: 3x-ui's 5 s job, phase bin 0 (J/64 past every
// multiple of 5 s since the epoch). t0 is such a multiple.
var (
	pollJ  = 5 * time.Second
	phase0 = pollJ / 64
	pollT0 = time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)
)

// ticked is a store whose panel already knows its tick, as a restart onto a
// saved `tickPhaseMask` does (F-027-cz).
func ticked() *store {
	s := newStore()
	mask := uint32(1)
	pn := s.panels[panelID]
	pn.Learned = leaseplan.Learned{TickPeriod: pollJ, TickMask: &mask}
	s.panels[panelID] = pn
	s.set(0, moving(0))
	return s
}

// sinceTick is how far t lies past the panel's last tick.
func sinceTick(t time.Time) time.Duration {
	off := t.Sub(pollT0.Add(phase0)) % pollJ
	if off < 0 {
		off += pollJ
	}
	return off
}

func read(t *testing.T, s *leaseplan.Planner, at time.Time) {
	t.Helper()
	if _, err := s.Plan(context.Background(), panel("c1"), []driver.ClientUsage{reading("c1", 0)}, at); err != nil {
		t.Fatalf("read at %v: %v", at, err)
	}
}

// A poll between two ticks reads nothing new (SPEC §5, weakness #12): once
// the phase is known, the next poll lands one second after a tick, never
// sooner than MinPoll after the last read.
func TestTheNextPollLandsOneSecondAfterATick(t *testing.T) {
	s := &leaseplan.Planner{Store: ticked()}
	if _, ok := s.NextPoll(panelID, 0); ok {
		t.Fatal("a poll was planned for a panel nothing has read or allocated")
	}
	last := pollT0.Add(1200 * time.Millisecond)
	read(t, s, last)

	next, ok := s.NextPoll(panelID, 0)
	if !ok {
		t.Fatal("no poll planned after a read with a Grant on the panel")
	}
	if got := sinceTick(next); got != leaseplan.PollGuard {
		t.Fatalf("next poll %v is %v past a tick, want %v", next, got, leaseplan.PollGuard)
	}
	if next.Sub(last) < quota.DefaultParams().MinPoll {
		t.Fatalf("next poll %v is inside MinPoll of the read at %v", next, last)
	}
}

// The panel's own budget floors the gap (per-panel MinPoll): a panel that
// allows a poll every 30 s is polled no sooner, and still on a tick.
func TestThePanelsBudgetFloorsTheGap(t *testing.T) {
	s := &leaseplan.Planner{Store: ticked()}
	last := pollT0.Add(1200 * time.Millisecond)
	read(t, s, last)

	next, _ := s.NextPoll(panelID, 30*time.Second)
	if next.Sub(last) < 30*time.Second {
		t.Fatalf("next poll %v is %v after the last, inside the panel's 30 s", next, next.Sub(last))
	}
	if got := sinceTick(next); got != leaseplan.PollGuard {
		t.Fatalf("next poll is %v past a tick, want %v", got, leaseplan.PollGuard)
	}
}

// Polls aligned to the tick teach the clock nothing, so a shifted phase would
// go unseen (SPEC §5 ⚠). Every ProbeEvery one extra poll lands halfway
// through the tick after an aligned one — inside J of it, or the clock learns
// nothing from the pair — and, once taken, the schedule is aligned again.
func TestAMidTickProbeEveryFiveMinutes(t *testing.T) {
	s := &leaseplan.Planner{Store: ticked()}
	read(t, s, pollT0.Add(1200*time.Millisecond))
	aligned := pollT0.Add(leaseplan.ProbeEvery + pollJ + phase0 + leaseplan.PollGuard)
	read(t, s, aligned)

	probe, _ := s.NextPoll(panelID, 0)
	if got := sinceTick(probe); got != pollJ/2 {
		t.Fatalf("probe %v is %v past a tick, want halfway (%v)", probe, got, pollJ/2)
	}
	if gap := probe.Sub(aligned); gap <= 0 || gap >= pollJ {
		t.Fatalf("probe is %v after the aligned read; it teaches the clock only inside one tick", gap)
	}

	read(t, s, probe)
	next, _ := s.NextPoll(panelID, 0)
	if got := sinceTick(next); got != leaseplan.PollGuard {
		t.Fatalf("after the probe the next poll is %v past a tick, want aligned again", got)
	}
}

// A budget that does not fit two reads inside one tick is never probed: the
// probe is the one poll that skips MinPoll, and it may not skip the owner's.
func TestNoProbeThePanelsBudgetCannotPay(t *testing.T) {
	s := &leaseplan.Planner{Store: ticked()}
	read(t, s, pollT0.Add(1200*time.Millisecond))
	aligned := pollT0.Add(leaseplan.ProbeEvery + pollJ + phase0 + leaseplan.PollGuard)
	read(t, s, aligned)

	next, _ := s.NextPoll(panelID, pollJ+time.Second)
	if got := sinceTick(next); got != leaseplan.PollGuard {
		t.Fatalf("a probe was planned %v past a tick inside a budget that allows one read per %v", got, pollJ+time.Second)
	}
}

// The poller reads a panel when the planner says, and only then: a sweep
// before the planned poll asks the panel nothing, one at it runs the whole
// turn — read, plan — once (weakness #11: the idle poll is the planner's
// figure, not the hot loop's fixed interval).
func TestThePollerReadsAPanelWhenThePlannerSays(t *testing.T) {
	st := ticked()
	planner := &leaseplan.Planner{Store: st}
	fp := fake.New(fake.Config{CounterSemantics: driver.CounterCumulative})
	fp.Given("c1")
	p := panel("c1")
	p.Transport, p.Driver, p.ReviewState = driver.TransportPull, fp, driver.ReviewAccepted

	now := pollT0.Add(1200 * time.Millisecond)
	loop := &collect.Loop{
		Source:  collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) { return []collect.Panel{p}, nil }),
		Sink:    &nullSink{},
		Cursors: collect.NewMemoryCursors(),
		Planner: planner,
		Clock:   func() time.Time { return now },
	}
	poller := &collect.Poller{Loop: loop, Panels: func() []collect.Panel { return []collect.Panel{p} }, Schedule: planner}

	poller.Sweep(context.Background())
	poller.Wait()
	if n := fp.CallCount("GetUsage"); n != 0 {
		t.Fatalf("%d read(s) before the planner planned any", n)
	}

	if _, err := loop.Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	due, ok := planner.NextPoll(p.ID, collect.PollGap(p))
	if !ok {
		t.Fatal("the bulk read planned no poll")
	}

	now = due.Add(-time.Second)
	poller.Sweep(context.Background())
	poller.Wait()
	if n := fp.CallCount("GetUsage"); n != 1 {
		t.Fatalf("%d reads a second before the planned poll, want the bulk pass's 1", n)
	}

	now = due
	poller.Sweep(context.Background())
	poller.Wait()
	if n := fp.CallCount("GetUsage"); n != 2 {
		t.Fatalf("%d reads at the planned poll, want 2", n)
	}
	if again, _ := planner.NextPoll(p.ID, collect.PollGap(p)); !again.After(due) {
		t.Fatalf("the polled read did not reach the planner: next poll %v, was %v", again, due)
	}
}

// A panel whose planned poll failed is asked again PollRetry later, not on
// every sweep: its hint is still due, and a down panel is asked on every pass.
func TestAFailedPollWaitsBeforeTheNext(t *testing.T) {
	planner := &leaseplan.Planner{Store: ticked()}
	fp := fake.New(fake.Config{CounterSemantics: driver.CounterCumulative})
	fp.Given("c1")
	p := panel("c1")
	p.Transport, p.Driver, p.ReviewState = driver.TransportPull, fp, driver.ReviewAccepted
	now := pollT0.Add(1200 * time.Millisecond)
	loop := &collect.Loop{Sink: &nullSink{}, Cursors: collect.NewMemoryCursors(), Planner: planner,
		Clock:  func() time.Time { return now },
		Source: collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) { return []collect.Panel{p}, nil })}
	poller := &collect.Poller{Loop: loop, Panels: func() []collect.Panel { return []collect.Panel{p} }, Schedule: planner}
	if _, err := loop.Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	due, _ := planner.NextPoll(p.ID, 0)

	sweep := func(at time.Time) int {
		now = at
		poller.Sweep(context.Background())
		poller.Wait()
		return fp.CallCount("GetUsage")
	}
	fp.FailNextCall(503)
	if n := sweep(due); n != 2 {
		t.Fatalf("%d reads, want the failed poll as the 2nd", n)
	}
	if n := sweep(due.Add(time.Second)); n != 2 {
		t.Fatal("a failed panel was asked again on the next sweep")
	}
	if n := sweep(due.Add(collect.PollRetry)); n != 3 {
		t.Fatalf("%d reads PollRetry after the failure, want 3", n)
	}
}

// PollGap spends half the owner's budget on polls, two requests each (the
// usage read and the convergence step's client list); the rest is the writes'.
func TestPollGapIsHalfThePanelsBudget(t *testing.T) {
	if got := collect.PollGap(collect.Panel{MaxRequestsPerMinute: 60}); got != 4*time.Second {
		t.Fatalf("60 a minute: gap %v, want 4s", got)
	}
	if got := collect.PollGap(collect.Panel{MaxRequestsPerMinute: 4}); got != time.Minute {
		t.Fatalf("4 a minute: gap %v, want 1m", got)
	}
}

type nullSink struct{}

func (nullSink) Publish(context.Context, collect.Result) error { return nil }
