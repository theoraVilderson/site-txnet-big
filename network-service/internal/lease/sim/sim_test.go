package sim

import (
	"strings"
	"testing"
)

// Regression suite: every weakness found while designing the engine has a
// scenario here. Bounds are deliberately a bit looser than current results.
func TestScenarios(t *testing.T) {
	for _, sc := range Scenarios() {
		r := Run(sc)
		a := r.Accounts[0]
		lo, hi, maxCut := -8.0, 5.0, 200.0
		switch {
		case strings.HasPrefix(sc.Name, "50GB"):
			lo = -100 // not finished on purpose; checks writes instead
			if r.Writes > 6 {
				t.Errorf("%s: %d writes for a big plan", sc.Name, r.Writes)
			}
		case strings.Contains(sc.Name, "enforcement dead"):
			hi = 15 // unavoidable; recovered as debt
		case strings.Contains(sc.Name, "wrong lag"):
			if a.Balance < -150<<20 || a.Balance > 150<<20 {
				t.Errorf("%s: carried balance %d MB", sc.Name, a.Balance>>20)
			}
		}
		if a.OverPct < lo || a.OverPct > hi {
			t.Errorf("%s: over %.2f%% outside [%v,%v]", sc.Name, a.OverPct, lo, hi)
		}
		if a.FalseCutSec > maxCut {
			t.Errorf("%s: %.0f cut seconds", sc.Name, a.FalseCutSec)
		}
		if r.InvariantMax > 0.2 {
			t.Errorf("%s: invariant %.3f", sc.Name, r.InvariantMax)
		}
	}
}

func TestFleet(t *testing.T) {
	if testing.Short() {
		t.Skip()
	}
	r := Run(Fleet(300, 6, 1, 3))
	var cut float64
	worst := -100.0
	for _, a := range r.Accounts {
		cut += a.FalseCutSec
		if a.Closed && a.OverPct > worst {
			worst = a.OverPct
		}
	}
	if frac := cut / (r.ActiveHours * 3600); frac > 0.001 {
		t.Errorf("devices cut %.4f%% of the time", frac*100)
	}
	if worst > 6 {
		t.Errorf("worst overshoot %.2f%%", worst)
	}
}
