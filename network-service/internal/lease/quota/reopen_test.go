package quota

import (
	"testing"
	"time"
)

// LIVE-1-u (2026-10-28): a package Grant guard-closed at 572.4/600 MiB while
// it ran at 5 MB/s stayed closed with traffic stopped, until the process
// restarted. Its only replica was disabled by the close, so every reading
// since was "blocked" and the estimator ignored its zeros (rate.go rule 3):
// the demand that closed it stayed at its peak, and so did the reopen bar
// (ΣvDem × FinishTime, lease-close rule 25), above the 27.6 MiB left.

func TestASettledGuardCloseReopensOnceItsTrafficStops(t *testing.T) {
	p := DefaultParams()
	t0 := time.Date(2026, 10, 28, 13, 51, 0, 0, time.UTC)
	pn := &PanelState{ID: "sanaee", Healthy: true, CanSetLimit: true,
		JobInterval: 5 * time.Second, Lag: NewLag(5 * time.Second), WriteRate: 2} // chill-sanaee ticks every 5 s
	used := 5724 * MB / 10
	r := &Replica{ID: 1, Panel: pn, Exists: true, Counter: used, LimitSeen: used, LimitWant: used,
		LimitPeak: used, PolledAt: t0, effAt: t0}
	// The estimate the close left: a throttled 5 MB/s that read a step high.
	r.Rate.Fast, r.Rate.Slow, r.Rate.N = 6*float64(MB), 2*float64(MB), 20
	a := &Account{Quota: 600 * MB, Used: used, Closed: true, closedQuota: 600 * MB,
		closedWhy: CloseGuard, closeWatched: true, closedAt: t0, closedUsed: used,
		Replicas: []*Replica{r}}

	const reopenBy = 3 * time.Minute
	for at := t0.Add(5 * time.Second); !at.After(t0.Add(reopenBy)); at = at.Add(5 * time.Second) {
		a.Observe(r, Observation{Counter: used, Limit: used, Enabled: false, At: at}, p.DriftAfter)
		a.Plan(at, p)
		if !a.Closed {
			return
		}
	}
	t.Fatalf("a guard close with %d MiB paid and no traffic was still closed %v later (demand %.1f MiB/s)",
		(a.Quota-a.Used)/MB, reopenBy, r.Rate.Demand()/float64(MB))
}
