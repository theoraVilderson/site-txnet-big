// simreport runs the regression scenarios and prints a table.
//
//	go run ./cmd/simreport
package main

import (
	"fmt"
	"sort"

	"network-service/internal/lease/quota"
	"network-service/internal/lease/sim"
)

func main() {
	fmt.Printf("%-44s %9s %9s %8s %7s %6s %6s %8s\n", "scenario", "paid MB", "used MB", "over%", "cut s", "writes", "polls", "inv max")
	for _, sc := range sim.Scenarios() {
		r := sim.Run(sc)
		a := r.Accounts[0]
		fmt.Printf("%-44s %9d %9.0f %+7.2f%% %7.0f %6d %6d %+8.4f\n", r.Name, a.Purchased/quota.MB, a.Consumed/float64(quota.MB), a.OverPct, a.FalseCutSec, r.Writes, r.Polls, r.InvariantMax)
		if len(a.PeriodUse) > 1 {
			for i, u := range a.PeriodUse {
				fmt.Printf("    period %d: paid %4d MB used %6.0f MB (%+.1f%%)\n", i+1, a.PeriodPaid[i]/quota.MB, u/float64(quota.MB), (u/float64(a.PeriodPaid[i])-1)*100)
			}
			fmt.Printf("    carried balance at end: %+.0f MB, learned lag: %v\n", float64(a.Balance)/float64(quota.MB), r.Lags)
		}
	}
	for _, wr := range []float64{3, 0.5} {
		r := sim.Run(sim.Fleet(600, 8, wr, 7))
		fleetReport(r)
	}
}

func fleetReport(r sim.Result) {
	var overs []float64
	cut, ended := 0.0, 0
	for _, a := range r.Accounts {
		if a.Closed {
			ended++
			overs = append(overs, a.OverPct)
		}
		cut += a.FalseCutSec
	}
	sort.Float64s(overs)
	q := func(f float64) float64 {
		if len(overs) == 0 {
			return 0
		}
		return overs[int(f*float64(len(overs)-1))]
	}
	fmt.Printf("\n%s\n", r.Name)
	fmt.Printf("  accounts finished: %d/%d  overshoot%% of finished: p5 %+.2f  p50 %+.2f  p95 %+.2f  max %+.2f\n", ended, len(r.Accounts), q(0.05), q(0.5), q(0.95), q(1))
	fmt.Printf("  writes: %d (%.1f per device-hour), peak writes/min on one panel: %d, polls: %d, false-cut device-seconds: %.0f, invariant max: %+.4f\n",
		r.Writes, float64(r.Writes)/r.ActiveHours, r.PeakWritesMin, r.Polls, cut, r.InvariantMax)
	fmt.Printf("  write reasons: %v, device-hours: %.0f\n", r.Reasons, r.ActiveHours)
}
