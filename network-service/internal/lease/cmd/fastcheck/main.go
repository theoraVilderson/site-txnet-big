package main

import (
	"fmt"
	"time"

	"network-service/internal/lease/quota"
	"network-service/internal/lease/sim"
)

func main() {
	mb := float64(quota.MB)
	for _, perDev := range []float64{500, 62.5, 12.5, 5, 1} { // MB/s per device
		for _, same := range []bool{true, false} {
			p := quota.DefaultParams()
			x := sim.PanelCfg{ID: "A", Job: 10 * time.Second, ExtraLagMax: 2 * time.Second, WriteLatency: time.Second, WriteRate: 2, CanSetLimit: true}
			y := x
			y.ID = "B"
			sc := sim.Scenario{Name: "fast", Duration: 600, Params: p, Panels: []sim.PanelCfg{x, y},
				Accounts: []sim.AcctCfg{{Quota: quota.GB, Panels: []int{0, 1}}}}
			for i := 0; i < 5; i++ {
				rep := 0
				if !same {
					rep = i % 2
				}
				sc.Devices = append(sc.Devices, sim.Device{Acct: 0, Rep: rep, Rate: perDev * mb, From: 30, To: 600})
			}
			var sumUse, worst float64
			const runs = 20
			for s := int64(0); s < runs; s++ {
				sc.Seed = s
				r := sim.Run(sc)
				u := r.Accounts[0].Consumed / mb
				sumUse += u
				if u > worst {
					worst = u
				}
			}
			fmt.Printf("%6.1f MB/s x5  sameConfig=%v  avg used %7.0f MB  worst %7.0f MB\n", perDev, same, sumUse/runs, worst)
		}
	}
}
