package driver

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The invariant this file turns on (F-027-df, SPEC weakness #15, #20): the
// owner's budget is a ceiling, not a target. A panel that says 429 or 5xx is
// asked at half the rate, and gets the rate back one answer at a time; a panel
// that fails BreakAfter times running is not asked at all until one probe has
// been let through, and the wait for that probe never passes a bulk pass.

// answering is a driver whose GetUsage returns whatever `next` holds.
type answering struct {
	Driver
	next  error
	calls int
}

func (a *answering) GetUsage(ctx context.Context) ([]ClientUsage, error) {
	a.calls++
	return nil, a.next
}

// room is how many calls get through before the budget makes one wait.
func room(t *testing.T, d Driver) int {
	t.Helper()
	n := 0
	for ; n < 1000; n++ {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
		_, err := d.GetUsage(ctx)
		cancel()
		var f *Fault
		if errors.As(err, &f) && f.Kind == FaultTimeout {
			return n
		}
	}
	t.Fatal("the budget never made a call wait")
	return n
}

func TestA429HalvesTheRateAndAnAnswerEarnsItBack(t *testing.T) {
	p := &answering{}
	pc := NewPacer(Budget{MaxRequests: 16, Window: time.Hour})
	d := pc.Wrap(p)

	p.next = NewFault(FaultRateLimited, "GetUsage", 429, nil)
	_, _ = d.GetUsage(context.Background())
	if got := pc.Rate(); got != 8 {
		t.Fatalf("after a 429 the rate is %v, want 8 — half the owner's 16", got)
	}
	p.next = nil
	// Each answer earns back 16/(2*RecoverAfter) = 0.5, so the hour holds 13
	// more calls rather than the 15 the owner's figure would have allowed.
	if got := room(t, d); got != 13 {
		t.Fatalf("%d more calls fit the hour, want 13", got)
	}
	if got := pc.Rate(); got != 14.5 {
		t.Fatalf("thirteen answers left the rate at %v, want 8 + 13*0.5 = 14.5", got)
	}
	for i := 0; i < RecoverAfter; i++ {
		pc.report(nil)
	}
	if got := pc.Rate(); got != 16 {
		t.Fatalf("RecoverAfter answers left the rate at %v, want the owner's 16", got)
	}
}

func TestTheRateNeverPassesTheOwnersFigure(t *testing.T) {
	p := &answering{}
	pc := NewPacer(Budget{MaxRequests: 4, Window: time.Hour})
	if got := room(t, pc.Wrap(p)); got != 4 {
		t.Fatalf("%d calls fit the hour, want the owner's 4", got)
	}
	if got := pc.Rate(); got != 4 {
		t.Fatalf("four answers raised the rate to %v past the owner's 4", got)
	}
}

func TestTheRateHasAFloor(t *testing.T) {
	p := &answering{next: NewFault(FaultRateLimited, "GetUsage", 429, nil)}
	pc := NewPacer(Budget{MaxRequests: 64, Window: time.Hour})
	d := pc.Wrap(p)
	for i := 0; i < 6; i++ { // 32, 16, 8, then held; all inside the floor's 8
		_, _ = d.GetUsage(context.Background())
	}
	if got := pc.Rate(); got != 8 {
		t.Fatalf("six 429s left the rate at %v, want the floor 8 (an eighth of 64)", got)
	}
}

func TestTheBreakerOpensAndOneProbeClosesIt(t *testing.T) {
	now := time.Unix(0, 0)
	p := &answering{next: NewFault(FaultUnavailable, "GetUsage", 502, nil)}
	pc := NewPacer(Budget{MaxRequests: 1000, Window: time.Hour})
	pc.now = func() time.Time { return now }
	d := pc.Wrap(p)

	for i := 0; i < BreakAfter; i++ {
		_, _ = d.GetUsage(context.Background())
	}
	if p.calls != BreakAfter {
		t.Fatalf("the panel saw %d calls, want %d", p.calls, BreakAfter)
	}
	_, err := d.GetUsage(context.Background())
	if !errors.Is(err, ErrCircuitOpen) || !IsUnavailable(err) {
		t.Fatalf("an open breaker returned %v, want an unavailable fault wrapping ErrCircuitOpen", err)
	}
	if p.calls != BreakAfter {
		t.Fatal("an open breaker let a call reach the panel")
	}

	now = now.Add(BreakerCooldown)
	_, _ = d.GetUsage(context.Background()) // the probe, and it fails
	if p.calls != BreakAfter+1 {
		t.Fatalf("after the cool-down the panel saw %d calls, want one probe", p.calls-BreakAfter)
	}
	now = now.Add(BreakerCooldown)
	if _, err := d.GetUsage(context.Background()); !errors.Is(err, ErrCircuitOpen) {
		t.Fatal("a failed probe did not double the cool-down")
	}

	now = now.Add(BreakerCooldown)
	p.next = nil
	if _, err := d.GetUsage(context.Background()); err != nil {
		t.Fatalf("the second probe failed: %v", err)
	}
	if _, err := d.GetUsage(context.Background()); err != nil {
		t.Fatalf("an answered probe did not close the breaker: %v", err)
	}
}

func TestTheBreakerNeverWaitsPastABulkPass(t *testing.T) {
	now := time.Unix(0, 0)
	p := &answering{next: NewFault(FaultUnavailable, "GetUsage", 502, nil)}
	pc := NewPacer(Budget{MaxRequests: 1000, Window: time.Hour})
	pc.now = func() time.Time { return now }
	d := pc.Wrap(p)

	for i := 0; i < 20; i++ {
		_, _ = d.GetUsage(context.Background())
		now = now.Add(MaxBreakerCooldown)
	}
	// Every probe after the first opening ran, so the wait never grew past
	// MaxBreakerCooldown: the first five open it, then one probe per wait.
	if p.calls != 20 {
		t.Fatalf("the panel saw %d of 20 calls a minute apart, want all 20", p.calls)
	}
}

func TestAFreshWrapperKeepsWhatThePacerLearned(t *testing.T) {
	p := &answering{next: NewFault(FaultRateLimited, "GetUsage", 429, nil)}
	pc := NewPacer(Budget{MaxRequests: 16, Window: time.Hour})
	_, _ = pc.Wrap(p).GetUsage(context.Background())
	if got, _ := PacerOf(pc.Wrap(&answering{})); got != pc {
		t.Fatal("PacerOf did not return the pacer the driver was wrapped with")
	}
	if got := pc.Rate(); got != 8 {
		t.Fatalf("a reopened driver would start at %v, want the halved 8", got)
	}
}
