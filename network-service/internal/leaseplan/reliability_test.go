package leaseplan_test

import (
	"context"
	"math"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
	"network-service/internal/lease/quota"
	"network-service/internal/leaseplan"
)

// SPEC weakness #21 (F-027-dh): a panel whose API dies while its nodes keep
// serving freezes whatever lease it holds. A panel with an outage history is
// given a smaller MaxLease, so the next one freezes less.

var relT0 = time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)

// relParams makes MaxLease bind well under the Grant's 1 GB bag.
func relParams() quota.Params {
	p := quota.DefaultParams()
	p.MaxLease = 256 * quota.MB
	return p
}

// firstWant is the lease a fresh config (no ceiling yet) is given on a read at at.
func firstWant(t *testing.T, pl *leaseplan.Planner, s *store, at time.Time) int64 {
	t.Helper()
	s.set(0, leaseplan.Config{ID: "config-c1", PanelID: panelID, Exists: true, Enabled: true})
	plans, err := pl.Plan(context.Background(), panel("c1"), []driver.ClientUsage{reading("c1", 0)}, at)
	if err != nil {
		t.Fatal(err)
	}
	if len(plans) != 1 || len(plans[0].Replicas) != 1 {
		t.Fatalf("plans %+v, want one Grant with one replica", plans)
	}
	return plans[0].Replicas[0].Want
}

func TestAnOutageShrinksThePanelsLeaseCap(t *testing.T) {
	steady := &leaseplan.Planner{Store: newStore(), Params: relParams()}
	if got := firstWant(t, steady, steady.Store.(*store), relT0); got != 256*quota.MB {
		t.Fatalf("a panel with no outage leases %d, want MaxLease (256 MB)", got)
	}

	k := &keeper{store: newStore()}
	flaky := &leaseplan.Planner{Store: k, Params: relParams()}
	flaky.Failed(panelID, relT0)
	flaky.Failed(panelID, relT0.Add(time.Minute)) // still down: the outage started at the first
	back := relT0.Add(5 * time.Minute)
	if got := firstWant(t, flaky, k.store, back); got != 128*quota.MB {
		t.Fatalf("after a 5 min outage the panel leases %d, want half of MaxLease (128 MB)", got)
	}
	if len(k.saves) == 0 {
		t.Fatal("the outage was not saved: a restart would forget it")
	}
	if s := k.saves[len(k.saves)-1]; s.OutageWeight != 1 || !s.OutageAt.Equal(back) {
		t.Fatalf("saved weight %v at %v, want 1 at %v", s.OutageWeight, s.OutageAt, back)
	}
}

// A blip counts for its length in OutageUnits; a failure never followed by
// an answer counts nothing yet.
func TestABlipCountsForItsLength(t *testing.T) {
	k := &keeper{store: newStore()}
	pl := &leaseplan.Planner{Store: k, Params: relParams()}
	pl.Failed(panelID, relT0)
	firstWant(t, pl, k.store, relT0.Add(30*time.Second))
	got, _ := pl.Learned(panelID)
	if math.Abs(got.OutageWeight-0.1) > 1e-9 {
		t.Fatalf("a 30 s outage weighs %v, want 0.1 of a 5 min unit", got.OutageWeight)
	}
}

// The history is the row's: a restarted planner caps the panel as the last
// one did, and the cap comes back as the outage ages.
func TestTheOutageHistorySurvivesARestartAndFades(t *testing.T) {
	k := &keeper{store: newStore()}
	pn := k.store.panels[panelID]
	pn.Learned = leaseplan.Learned{OutageWeight: 1, OutageAt: relT0}
	k.store.panels[panelID] = pn

	restarted := &leaseplan.Planner{Store: k, Params: relParams()}
	if got := firstWant(t, restarted, k.store, relT0); got != 128*quota.MB {
		t.Fatalf("a restarted planner leases %d on a panel with one outage, want 128 MB", got)
	}
	day := &leaseplan.Planner{Store: k, Params: relParams()}
	// One half-life later the weight is 0.5: 256 / 1.5.
	if got, want := firstWant(t, day, k.store, relT0.Add(24*time.Hour)), int64(178956970); got < want-1 || got > want+1 {
		t.Fatalf("a day after the outage the panel leases %d, want %d", got, want)
	}
	for _, s := range k.saves {
		if s.OutageWeight != 1 || !s.OutageAt.Equal(relT0) {
			t.Fatalf("saved weight %v at %v: fading is computed, never written", s.OutageWeight, s.OutageAt)
		}
	}
}

// The collector tells the planner of a read that failed, so a panel that
// answers again is planned with the outage it just had.
func TestAFailedReadThroughTheLoopIsAnOutage(t *testing.T) {
	s := newStore()
	s.set(0, leaseplan.Config{ID: "config-c1", PanelID: panelID, Exists: true, Enabled: true})
	pl := &leaseplan.Planner{Store: s, Params: relParams()}
	fp := fake.New(fake.Config{CounterSemantics: driver.CounterCumulative})
	fp.Given("c1")
	p := panel("c1")
	p.Transport, p.Driver, p.ReviewState = driver.TransportPull, fp, driver.ReviewAccepted
	now := relT0
	loop := &collect.Loop{Sink: &nullSink{}, Cursors: collect.NewMemoryCursors(), Planner: pl,
		Clock:  func() time.Time { return now },
		Source: collect.PanelsFunc(func(context.Context) ([]collect.Panel, error) { return []collect.Panel{p}, nil })}

	fp.FailNextCall(503)
	if _, err := loop.Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	now = relT0.Add(5 * time.Minute)
	if _, err := loop.Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got, _ := pl.Learned(panelID); got.OutageWeight != 1 || !got.OutageAt.Equal(now) {
		t.Fatalf("after a 5 min outage the panel holds weight %v at %v, want 1 at %v", got.OutageWeight, got.OutageAt, now)
	}
}
