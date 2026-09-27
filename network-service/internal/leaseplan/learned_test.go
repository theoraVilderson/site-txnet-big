package leaseplan_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
	"network-service/internal/lease/quota"
	"network-service/internal/leaseplan"
)

// keeper is a store that also keeps what the shadow saves of a panel, the way
// `network.panel` does across a restart (F-027-cz).
type keeper struct {
	*store
	mu    sync.Mutex
	saves []leaseplan.Learned
}

func (k *keeper) SaveLearned(_ context.Context, panelID string, l leaseplan.Learned) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.saves = append(k.saves, l)
	k.store.mu.Lock()
	defer k.store.mu.Unlock()
	pn := k.store.panels[panelID]
	pn.Learned = l
	k.store.panels[panelID] = pn
	return nil
}

func moving(counter int64) leaseplan.Config {
	return leaseplan.Config{ID: "config-c1", PanelID: panelID, Exists: true, Counter: counter, LimitSeen: 500 * quota.MB, Enabled: true}
}

// A panel's clock is learned over polls and kept on its row: a shadow started
// after a restart plans with the mask and lag the last one saved, not the
// family's blank figures.
func TestWhatAPanelLearnedSurvivesARestart(t *testing.T) {
	k := &keeper{store: newStore()}
	before := &leaseplan.Shadow{Store: k}
	p := panel("c1")
	t0 := time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)

	// Counters move 2 s after the first read, then stand still 1.5 s later:
	// two observations inside one 5 s tick of the 3x-ui family.
	for i, step := range []struct {
		at      time.Duration
		counter int64
	}{{0, 0}, {2 * time.Second, 10 * quota.MB}, {3500 * time.Millisecond, 10 * quota.MB}} {
		k.set(step.counter, moving(step.counter))
		if _, err := before.Plan(context.Background(), p, []driver.ClientUsage{reading("c1", step.counter)}, t0.Add(step.at)); err != nil {
			t.Fatalf("pass %d: %v", i+1, err)
		}
	}
	if len(k.saves) == 0 {
		t.Fatal("nothing was saved: the clock learned from two polls and the row never heard of it")
	}
	saved := k.saves[len(k.saves)-1]
	if saved.TickPeriod != 5*time.Second || saved.TickMask == nil || *saved.TickMask == ^uint32(0) {
		t.Fatalf("saved %+v, want the 5 s period and a mask narrowed by the observations", saved)
	}
	learned, _ := before.Learned(panelID)
	if !learned.Equal(saved) {
		t.Fatalf("saved %+v, but the shadow holds %+v", saved, learned)
	}

	// The restart: a new shadow over the same rows.
	after := &leaseplan.Shadow{Store: k}
	k.set(10*quota.MB, moving(10*quota.MB))
	if _, err := after.Plan(context.Background(), p, []driver.ClientUsage{reading("c1", 10*quota.MB)}, t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if got, ok := after.Learned(panelID); !ok || !got.Equal(saved) {
		t.Fatalf("after a restart the panel holds %+v, want %+v as saved", got, saved)
	}
}

// A lag the row holds is loaded as the planner's estimate, and a pass that
// learns nothing new writes nothing: the row is written when the state moves,
// not once per pass.
func TestALoadedLagIsKeptAndAnUnchangedPanelIsNotWritten(t *testing.T) {
	k := &keeper{store: newStore()}
	mask := uint32(0x00f0)
	pn := k.store.panels[panelID]
	pn.Learned = leaseplan.Learned{TickPeriod: 5 * time.Second, TickMask: &mask, LagMeanSec: 21, LagVarianceSec2: 4, LagSamples: 3}
	k.store.panels[panelID] = pn

	sh := &leaseplan.Shadow{Store: k}
	k.set(0, moving(0))
	if _, err := sh.Plan(context.Background(), panel("c1"), []driver.ClientUsage{reading("c1", 0)}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if got, _ := sh.Learned(panelID); !got.Equal(pn.Learned) {
		t.Fatalf("loaded %+v, want %+v", got, pn.Learned)
	}
	if len(k.saves) != 0 {
		t.Fatalf("saved %+v on a pass that learned nothing", k.saves)
	}
}

// The guard band's lag is the panel's own once the planner has measured one,
// and the family's until then (F-027-co's 35 s for 3x-ui).
func TestTheGuardBandReadsTheLearnedLag(t *testing.T) {
	p := collect.Panel{DriverType: driver.DriverSanaee}
	if got := p.EnforcementLag(); got != 35*time.Second {
		t.Fatalf("no samples: lag %v, want the family's 35s", got)
	}
	p.LagMeanSec, p.LagVarianceSec2, p.LagSamples = 12, 9, 4
	if got := p.EnforcementLag(); got != 12*time.Second {
		t.Fatalf("learned 12 s: lag %v, want 12s (mean + LagZ·σ, LagZ %v)", got, quota.DefaultParams().LagZ)
	}
}
