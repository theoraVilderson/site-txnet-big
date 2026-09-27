package sim

import (
	"fmt"
	"math/rand"
	"time"

	"network-service/internal/lease/quota"
)

const mbps = float64(quota.MB) // 1 MB/s

func xui(id string) PanelCfg {
	return PanelCfg{ID: id, Job: 10 * time.Second, ExtraLagMax: 2 * time.Second,
		WriteLatency: time.Second, WriteRate: 2, CanSetLimit: true}
}

func marz(id string) PanelCfg {
	return PanelCfg{ID: id, Job: 10 * time.Second, ExtraLagMax: 6 * time.Second,
		WriteLatency: time.Second, WriteRate: 3, CanSetLimit: true}
}

func slowPanel(id string) PanelCfg { // Hiddify-like: slow usage refresh
	return PanelCfg{ID: id, Job: 30 * time.Second, ExtraLagMax: 20 * time.Second,
		WriteLatency: 2 * time.Second, WriteRate: 1, CanSetLimit: true}
}

// Scenarios is the regression suite. Each one targets a weakness.
func Scenarios() []Scenario {
	p := quota.DefaultParams()
	var out []Scenario

	// W1: the user's question. 1 GB, five devices at 5 MB/s over two panels.
	{
		sc := Scenario{Name: "1GB, 5 devices x 5MB/s, 2 panels", Duration: 400, Params: p,
			Panels:   []PanelCfg{xui("A"), marz("B")},
			Accounts: []AcctCfg{{Quota: 1 * quota.GB, Panels: []int{0, 1}}}}
		for i := 0; i < 5; i++ {
			sc.Devices = append(sc.Devices, Device{Acct: 0, Rep: i % 2, Rate: 5 * mbps, From: 30, To: 400})
		}
		out = append(out, sc)
	}
	// W2: cold start — device moves to a config that was idle.
	out = append(out, Scenario{Name: "cold switch to idle config", Duration: 600, Params: p,
		Panels:   []PanelCfg{xui("A"), xui("B"), xui("C")},
		Accounts: []AcctCfg{{Quota: 1 * quota.GB, Panels: []int{0, 1, 2}}},
		Devices: []Device{
			{Acct: 0, Rep: 0, Rate: 3 * mbps, From: 30, To: 150},
			{Acct: 0, Rep: 2, Rate: 3 * mbps, From: 150, To: 600},
		}})
	// W3: switch to an idle config late in the endgame (tail lease).
	out = append(out, Scenario{Name: "switch config inside endgame", Duration: 600, Params: p,
		Panels:   []PanelCfg{xui("A"), xui("B")},
		Accounts: []AcctCfg{{Quota: 1 * quota.GB, Panels: []int{0, 1}}},
		Devices: []Device{
			{Acct: 0, Rep: 0, Rate: 4 * mbps, From: 30, To: 250},
			{Acct: 0, Rep: 1, Rate: 4 * mbps, From: 250, To: 600},
		}})
	// W4: big plan — writes must be near zero.
	out = append(out, Scenario{Name: "50GB plan, 2h, 2 devices", Duration: 7200, Params: p,
		Panels:   []PanelCfg{xui("A"), marz("B")},
		Accounts: []AcctCfg{{Quota: 50 * quota.GB, Panels: []int{0, 1}}},
		Devices: []Device{
			{Acct: 0, Rep: 0, Rate: 2 * mbps, From: 10, To: 7200},
			{Acct: 0, Rep: 1, Rate: 1 * mbps, From: 3600, To: 7200},
		}})
	// W5: badly guessed lag + renewals: calibration and debt/credit carry.
	{
		pc := slowPanel("S")
		pc.LagGuess = 3 * time.Second
		var ren []Renewal
		for i := 1; i <= 5; i++ {
			ren = append(ren, Renewal{At: float64(i) * 400, Add: 1 * quota.GB})
		}
		out = append(out, Scenario{Name: "wrong lag guess (3s vs ~40s) + 5 renewals", Duration: 2400, Params: p,
			Panels:   []PanelCfg{pc},
			Accounts: []AcctCfg{{Quota: 1 * quota.GB, Panels: []int{0}, Renewals: ren}},
			Devices:  []Device{{Acct: 0, Rep: 0, Rate: 8 * mbps, From: 10, To: 2400}}})
	}
	// W6: panel API outage, enforcement alive.
	{
		b := marz("B")
		b.Outages = [][2]float64{{60, 400}}
		out = append(out, Scenario{Name: "panel API down 340s", Duration: 900, Params: p,
			Panels:   []PanelCfg{xui("A"), b},
			Accounts: []AcctCfg{{Quota: 2 * quota.GB, Panels: []int{0, 1}}},
			Devices: []Device{
				{Acct: 0, Rep: 0, Rate: 3 * mbps, From: 10, To: 900},
				{Acct: 0, Rep: 1, Rate: 3 * mbps, From: 10, To: 900},
			}})
	}
	// W7: worst case — panel down AND not enforcing (node keeps serving).
	{
		b := marz("B")
		b.Outages = [][2]float64{{60, 400}}
		b.DeadInOutage = true
		out = append(out, Scenario{Name: "panel down + enforcement dead", Duration: 900, Params: p,
			Panels:   []PanelCfg{xui("A"), b},
			Accounts: []AcctCfg{{Quota: 2 * quota.GB, Panels: []int{0, 1}}},
			Devices: []Device{
				{Acct: 0, Rep: 0, Rate: 3 * mbps, From: 10, To: 900},
				{Acct: 0, Rep: 1, Rate: 3 * mbps, From: 10, To: 900},
			}})
	}
	// W8: admin resets counters mid-session.
	{
		a := xui("A")
		a.Resets = []float64{120}
		out = append(out, Scenario{Name: "counter reset on panel", Duration: 700, Params: p,
			Panels:   []PanelCfg{a, marz("B")},
			Accounts: []AcctCfg{{Quota: 1 * quota.GB, Panels: []int{0, 1}}},
			Devices: []Device{
				{Acct: 0, Rep: 0, Rate: 2 * mbps, From: 10, To: 700},
				{Acct: 0, Rep: 1, Rate: 1 * mbps, From: 10, To: 700},
			}})
	}
	// W9: K=N=10 inbounds, 10 devices each on a different config.
	{
		sc := Scenario{Name: "1GB, 10 configs, 10 devices", Duration: 600, Params: p}
		for i := 0; i < 5; i++ {
			sc.Panels = append(sc.Panels, xui(fmt.Sprintf("P%d", i)))
		}
		ac := AcctCfg{Quota: 1 * quota.GB}
		for i := 0; i < 10; i++ {
			ac.Panels = append(ac.Panels, i%5)
			sc.Devices = append(sc.Devices, Device{Acct: 0, Rep: i, Rate: 1 * mbps, From: 20 + float64(i*5), To: 600})
		}
		sc.Accounts = []AcctCfg{ac}
		out = append(out, sc)
	}
	// W10: bursty usage.
	{
		sc := Scenario{Name: "bursty 20MB/s bursts", Duration: 1800, Params: p,
			Panels:   []PanelCfg{xui("A"), xui("B")},
			Accounts: []AcctCfg{{Quota: 2 * quota.GB, Panels: []int{0, 1}}}}
		for t := 30.0; t < 1800; t += 60 {
			sc.Devices = append(sc.Devices, Device{Acct: 0, Rep: int(t/60) % 2, Rate: 20 * mbps, From: t, To: t + 10})
		}
		out = append(out, sc)
	}
	// W11: reactive panel (limit not writable, e.g. MikroTik UM).
	{
		m := PanelCfg{ID: "M", Job: 5 * time.Second, ExtraLagMax: time.Second, WriteLatency: time.Second, WriteRate: 2}
		out = append(out, Scenario{Name: "reactive panel (no per-client limit)", Duration: 900, Params: p,
			Panels:   []PanelCfg{m},
			Accounts: []AcctCfg{{Quota: 1 * quota.GB, Panels: []int{0}}},
			Devices:  []Device{{Acct: 0, Rep: 0, Rate: 2 * mbps, From: 10, To: 900}}})
	}
	return out
}

// Fleet is a load scenario: many accounts, few panels, K=2, random usage.
func Fleet(nAcct, nPanels int, writeRate float64, seed int64) Scenario {
	rng := rand.New(rand.NewSource(seed))
	p := quota.DefaultParams()
	sc := Scenario{Name: fmt.Sprintf("fleet %d users / %d panels (K=2, %.1f writes/s)", nAcct, nPanels, writeRate),
		Duration: 7600, Params: p, Seed: seed}
	for i := 0; i < nPanels; i++ {
		c := xui(fmt.Sprintf("F%d", i))
		if i%2 == 1 {
			c = marz(fmt.Sprintf("F%d", i))
		}
		c.WriteRate = writeRate
		sc.Panels = append(sc.Panels, c)
	}
	quotas := []quota.Bytes{1 * quota.GB, 2 * quota.GB, 5 * quota.GB, 10 * quota.GB, 30 * quota.GB}
	for a := 0; a < nAcct; a++ {
		p1 := rng.Intn(nPanels)
		p2 := (p1 + 1 + rng.Intn(nPanels-1)) % nPanels
		sc.Accounts = append(sc.Accounts, AcctCfg{Quota: quotas[rng.Intn(len(quotas))], Panels: []int{p1, p2}})
		nDev := 1 + rng.Intn(4)
		for d := 0; d < nDev; d++ {
			from := 400 + rng.Float64()*3600 // after the initial bulk creation
			dur := 300 + rng.Float64()*3600
			rate := (0.2 + rng.ExpFloat64()*1.5) * mbps
			sc.Devices = append(sc.Devices, Device{Acct: a, Rep: rng.Intn(2), Rate: rate, From: from, To: from + dur})
		}
	}
	return sc
}
