// Command shadowreport reads the lease planner's shadow lines from the
// service's log and prints, per Grant, the planner beside the live allocator
// (F-027-da, `contract.lease.md` rules 13-15):
//
//	docker logs txnet-dev-network-service 2>&1 | go run ./cmd/shadowreport
//	docker logs ... 2>&1 | go run ./cmd/shadowreport -grant 9298a1f9
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"network-service/internal/lease/quota"
	"network-service/internal/leaseplan"
)

func main() {
	grant := flag.String("grant", "", "only Grants whose id starts with this")
	flag.Parse()

	rep, err := leaseplan.ReadReport(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "reading the log:", err)
		os.Exit(1)
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', tabwriter.AlignRight)
	fmt.Fprintln(w, "grant\tturns\tspan\tquota MB\tused MB\tovershoot\tlive commit\tplanner commit\tlive false-cut s\tplanner false-cut s\tmax diverge\tclosed\t")
	for _, g := range rep.Grants {
		if !strings.HasPrefix(g.ID, *grant) {
			continue
		}
		fmt.Fprintf(w, "%s\t%d\t%s\t%d\t%d\t%s\t%s\t%s\t%.0f\t%.0f\t%.2f%%\t%v\t\n",
			g.ID[:min(8, len(g.ID))], g.Turns, g.Last.Sub(g.First).Round(1e9), g.Quota/quota.MB, g.Used/quota.MB,
			pct(g.Overshoot, g.Quota), pct(g.LiveCommitOver, g.Quota), pct(g.PlannerCommitOver, g.Quota),
			g.LiveFalseCut.Seconds(), g.PlannerFalseCut.Seconds(), 100*g.MaxDivergence, g.Closed)
	}
	w.Flush()
}

// pct is a figure as a signed share of the Grant's Quota.
func pct(v, of int64) string {
	if of <= 0 {
		return "-"
	}
	return fmt.Sprintf("%+.2f%%", 100*float64(v)/float64(of))
}
