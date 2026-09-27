package quota

import (
	"math/rand"
	"testing"
	"time"
)

func TestDelta(t *testing.T) {
	if d, r := Delta(100, 150); d != 50 || r {
		t.Fatal(d, r)
	}
	if d, r := Delta(100, 30); d != 30 || !r {
		t.Fatal("reset", d, r)
	}
}

func TestLagCalibrates(t *testing.T) {
	l := NewLag(10 * time.Second)
	for i := 0; i < 40; i++ {
		l.Observe(6 + float64(i%3)) // 6,7,8
	}
	if m := l.Reserve(0).Seconds(); m < 6.5 || m > 7.5 {
		t.Fatalf("mean lag %.2f", m)
	}
	if l.Reserve(1) <= l.Reserve(0) {
		t.Fatal("z=1 must be more conservative")
	}
}

// Property: a plan never grows total exposure beyond what is free.
// Σhold_after ≤ max(Σhold_before, Quota−Used−lagReserve) (+1 byte rounding).
func TestPlanNeverOvercommits(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	p := DefaultParams()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for it := 0; it < 20000; it++ {
		panels := []*PanelState{}
		for i := 0; i < 1+rng.Intn(4); i++ {
			pn := &PanelState{ID: string(rune('a' + i)), Healthy: rng.Intn(10) > 0, CanSetLimit: true,
				JobInterval: 10 * time.Second, Lag: NewLag(10 * time.Second), WriteRate: 2}
			panels = append(panels, pn)
		}
		q := Bytes(1+rng.Intn(20)) * GB / 4
		a := &Account{Quota: q, Used: Bytes(rng.Int63n(int64(q)))}
		for i := 0; i < 1+rng.Intn(6); i++ {
			c := Bytes(rng.Int63n(int64(GB)))
			lim := c + Bytes(rng.Int63n(int64(GB/2))) - GB/8
			r := &Replica{ID: int64(i), Panel: panels[rng.Intn(len(panels))], Exists: true,
				Counter: c, LimitSeen: lim, LimitWant: lim, LimitPeak: max(lim, c),
				EnabledSeen: lim > c && rng.Intn(5) > 0, PolledAt: now.Add(-time.Duration(rng.Intn(20)) * time.Second)}
			r.WantEnabled = r.EnabledSeen
			r.effAt = r.PolledAt
			r.Rate.Fast = rng.ExpFloat64() * float64(MB) * float64(rng.Intn(2))
			r.Rate.Slow = r.Rate.Fast * rng.Float64()
			a.Replicas = append(a.Replicas, r)
		}
		var before Bytes
		for _, r := range a.Replicas {
			before += r.Hold()
		}
		// lag reserve as the planner computes it (upper bound: use Demand)
		var lagRes float64
		for _, r := range a.Replicas {
			if r.EnabledSeen || r.WantEnabled {
				lagRes += r.Rate.Now() * r.Panel.Lag.Reserve(p.LagZ).Seconds()
			}
		}
		budget := a.Quota - a.Used - Bytes(lagRes)
		a.Plan(now, p)
		var after Bytes
		for _, r := range a.Replicas {
			after += r.Hold()
		}
		if after > max(before, budget)+1 {
			t.Fatalf("iter %d: overcommit: before %d after %d budget %d", it, before, after, budget)
		}
	}
}

func BenchmarkPlan(b *testing.B) {
	p := DefaultParams()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	pn := &PanelState{ID: "a", Healthy: true, CanSetLimit: true, JobInterval: 10 * time.Second, Lag: NewLag(10 * time.Second), WriteRate: 2}
	a := &Account{Quota: 10 * GB, Used: 3 * GB}
	for i := 0; i < 3; i++ {
		r := &Replica{ID: int64(i), Panel: pn, Exists: true, Counter: GB, LimitSeen: 2 * GB, LimitWant: 2 * GB, LimitPeak: 2 * GB, EnabledSeen: true, WantEnabled: true, PolledAt: now, effAt: now}
		r.Rate.Fast, r.Rate.Slow = float64(MB), float64(MB)
		a.Replicas = append(a.Replicas, r)
	}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		a.Plan(now.Add(time.Duration(i)*time.Second), p)
	}
}
