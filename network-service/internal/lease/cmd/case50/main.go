// case50: 50 GB, 4 users x 20 MB/s, 2 on config A (panel X), 2 on config B (panel Y).
package main

import (
	"fmt"
	"math/rand"
	"sort"
	"strings"
	"time"

	"network-service/internal/lease/quota"
	"network-service/internal/lease/sim"
)

const mb = float64(quota.MB)

var panelIdx = []int{0, 1}

func panels() []sim.PanelCfg {
	x := sim.PanelCfg{ID: "X", Job: 10 * time.Second, ExtraLagMax: 2 * time.Second, WriteLatency: time.Second, WriteRate: 2, CanSetLimit: true}
	y := sim.PanelCfg{ID: "Y", Job: 10 * time.Second, ExtraLagMax: 6 * time.Second, WriteLatency: time.Second, WriteRate: 3, CanSetLimit: true}
	return []sim.PanelCfg{x, y}
}

func run(name string, devs []sim.Device, dur float64, seeds int, trace bool) {
	var uses []float64
	var writes, polls, cut, reasons = 0, 0, 0.0, map[string]int{}
	for s := 0; s < seeds; s++ {
		sc := sim.Scenario{Name: name, Duration: dur, Params: quota.DefaultParams(), Panels: panels(),
			Accounts: []sim.AcctCfg{{Quota: 50 * quota.GB, Panels: panelIdx}}, Devices: devs, Seed: int64(s), TraceAcct: -1}
		if trace && s == 0 {
			sc.Trace = func(f string, a ...any) {
				l := fmt.Sprintf(f, a...)
				if strings.Contains(l, "->") || (strings.HasPrefix(l, "t=") && strings.Contains(l, "endgame=true")) {
					fmt.Println(l)
				}
			}
		}
		r := sim.Run(sc)
		a := r.Accounts[0]
		uses = append(uses, a.Consumed/mb)
		writes += r.Writes
		polls += r.Polls
		cut += a.FalseCutSec
		for k, v := range r.Reasons {
			reasons[k] += v
		}
	}
	sort.Float64s(uses)
	paid := 50 * 1024.0
	fmt.Printf("\n== %s (%d runs)\n", name, seeds)
	fmt.Printf("used MB: min %.0f  median %.0f  max %.0f   (paid %.0f) -> over: min %+.0f MB, median %+.0f MB, max %+.0f MB (%+.2f%%)\n",
		uses[0], uses[len(uses)/2], uses[len(uses)-1], paid, uses[0]-paid, uses[len(uses)/2]-paid, uses[len(uses)-1]-paid, (uses[len(uses)-1]-paid)/paid*100)
	fmt.Printf("per run: writes %.1f, polls %.0f, cut device-seconds %.1f, reasons %v\n",
		float64(writes)/float64(seeds), float64(polls)/float64(seeds), cut/float64(seeds), reasons)
}

func main() {
	// A) continuous: everyone at 20 MB/s nonstop
	var cont []sim.Device
	for i := 0; i < 4; i++ {
		cont = append(cont, sim.Device{Acct: 0, Rep: i / 2, Rate: 20 * mb, From: 30, To: 3600})
	}
	run("A) continuous, 4 x 20MB/s", cont, 3600, 30, true)

	// B) realistic: sessions of 2-20 min, random pauses, over 7 days, 20 MB/s when active
	rng := rand.New(rand.NewSource(42))
	var real []sim.Device
	for u := 0; u < 4; u++ {
		t := 60.0 + rng.Float64()*3600
		for t < 7*86400 {
			d := 120 + rng.Float64()*1080
			real = append(real, sim.Device{Acct: 0, Rep: u / 2, Rate: 20 * mb, From: t, To: t + d})
			t += d + 600 + rng.ExpFloat64()*4*3600
		}
	}
	run("B) realistic sessions over 7 days", real, 7*86400, 10, false)

	// C) same 3x-ui panel, two inbounds (two clients = two meters on one panel)
	panelIdx = []int{0, 0}
	run("C) continuous, 2 inbounds on ONE panel", cont, 3600, 30, false)
	run("D) realistic, 2 inbounds on ONE panel", real, 7*86400, 10, false)
}
