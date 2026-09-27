// case50inb: 50 GB, 4 people x 20 MB/s. 3x-ui style: every inbound is its own
// meter, so 2 configs x 2 inbounds = 4 replicas (A1,A2 on panel X; B1,B2 on panel Y).
package main

import (
	"fmt"
	"sort"
	"time"

	"network-service/internal/lease/quota"
	"network-service/internal/lease/sim"
)

const mb = float64(quota.MB)

func run(name string, devs []sim.Device, seeds int) {
	x := sim.PanelCfg{ID: "X", Job: 10 * time.Second, ExtraLagMax: 2 * time.Second, WriteLatency: time.Second, WriteRate: 2, CanSetLimit: true}
	y := x
	y.ID = "Y"
	var uses []float64
	writes, cut := 0, 0.0
	for s := 0; s < seeds; s++ {
		sc := sim.Scenario{Name: name, Duration: 3600, Params: quota.DefaultParams(), Panels: []sim.PanelCfg{x, y},
			// replicas: 0=A1 1=A2 (panel X), 2=B1 3=B2 (panel Y)
			Accounts: []sim.AcctCfg{{Quota: 50 * quota.GB, Panels: []int{0, 0, 1, 1}}}, Devices: devs, Seed: int64(s)}
		r := sim.Run(sc)
		uses = append(uses, r.Accounts[0].Consumed/mb)
		writes += r.Writes
		cut += r.Accounts[0].FalseCutSec
	}
	sort.Float64s(uses)
	paid := 50 * 1024.0
	fmt.Printf("%-52s over: min %+5.0f MB  median %+5.0f MB  max %+5.0f MB (%+.2f%%) | writes %.1f | cut dev-s %.1f\n",
		name, uses[0]-paid, uses[len(uses)/2]-paid, uses[len(uses)-1]-paid, (uses[len(uses)-1]-paid)/paid*100,
		float64(writes)/float64(seeds), cut/float64(seeds))
}

func d(rep int, from, to float64) sim.Device {
	return sim.Device{Acct: 0, Rep: rep, Rate: 20 * mb, From: from, To: to}
}

func main() {
	run("1) each person on a different inbound (A1,A2,B1,B2)", []sim.Device{d(0, 30, 3600), d(1, 30, 3600), d(2, 30, 3600), d(3, 30, 3600)}, 30)
	run("2) 2 on A1, 2 on B1, A2/B2 idle", []sim.Device{d(0, 30, 3600), d(0, 30, 3600), d(2, 30, 3600), d(2, 30, 3600)}, 30)
	run("3) like 2, then everyone fails over to A2/B2 at 5min", []sim.Device{d(0, 30, 300), d(0, 30, 300), d(2, 30, 300), d(2, 30, 300),
		d(1, 300, 3600), d(1, 300, 3600), d(3, 300, 3600), d(3, 300, 3600)}, 30)
	run("4) failover inside the endgame (9 min)", []sim.Device{d(0, 30, 540), d(0, 30, 540), d(2, 30, 540), d(2, 30, 540),
		d(1, 540, 3600), d(1, 540, 3600), d(3, 540, 3600), d(3, 540, 3600)}, 30)
}
