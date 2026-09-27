// simtrace prints a step-by-step trace of one scenario:
//
//	go run ./cmd/simtrace 2          # scenario #2
//	go run ./cmd/simtrace fleet 0.5  # worst account of the fleet run
package main

import (
	"fmt"
	"os"
	"strconv"

	"network-service/internal/lease/sim"
)

func main() {
	var sc sim.Scenario
	if os.Args[1] == "fleet" {
		wr, _ := strconv.ParseFloat(os.Args[2], 64)
		sc = sim.Fleet(600, 8, wr, 7)
		r := sim.Run(sc)
		worst, w := 0, 0.0
		for i, a := range r.Accounts {
			if a.FalseCutSec > w {
				worst, w = i, a.FalseCutSec
			}
		}
		fmt.Printf("worst account %d: %+v\n", worst, r.Accounts[worst])
		for _, d := range sc.Devices {
			if d.Acct == worst {
				fmt.Printf("  device rep%d %.1fMB/s %0.f-%0.f\n", d.Rep, d.Rate/1048576, d.From, d.To)
			}
		}
		sc.TraceAcct = worst
	} else {
		i, _ := strconv.Atoi(os.Args[1])
		sc = sim.Scenarios()[i]
		sc.TraceAcct = -1
	}
	sc.Trace = func(f string, a ...any) { fmt.Printf(f+"\n", a...) }
	r := sim.Run(sc)
	fmt.Printf("%+v\n", r.Accounts[max(sc.TraceAcct, 0)])
}
