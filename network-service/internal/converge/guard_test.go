package converge_test

import (
	"testing"
	"time"

	"network-service/internal/converge"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
)

// The guard band (F-027-co): a panel cuts a client some seconds after it
// crosses its ceiling — 3x-ui checks traffic every 5 s and restarts Xray for
// up to 30 s more — and everything served in that lag lands past the share,
// billed by nobody. So the ceiling written is the share less what the config's
// own measured rate carries in that lag, and the overrun falls inside the bag.

const (
	mbps200  = int64(200_000_000) // 25 MB/s
	band200  = int64(25_000_000 * 35)
	panelLag = 35 * time.Second
)

func (r *rig) allocateAt(remoteID string, bytes, rateBps int64) {
	r.store.Allocate("panel-1", converge.Allocation{
		ConfigID: "config-" + remoteID, RemoteID: remoteID, AllocatedBytes: bytes, RateBps: rateBps,
	})
}

func TestEveryRealFamilyHasALagAndTheFakeHasNone(t *testing.T) {
	for _, family := range []driver.DriverType{driver.DriverThreeXUI, driver.DriverSanaee, driver.DriverXUIAlireza} {
		if got := family.EnforcementLag(); got != panelLag {
			t.Errorf("%s lag = %v, want %v (5 s traffic check + 30 s restart)", family, got, panelLag)
		}
	}
	if got := driver.DriverMarzban.EnforcementLag(); got <= 0 {
		t.Errorf("an unmeasured family gets no band (%v): its lag is still served past the share", got)
	}
	if got := driver.DriverFake.EnforcementLag(); got != 0 {
		t.Errorf("fake lag = %v, want 0", got)
	}
}

func TestTheCeilingIsTheShareLessTheRateOverTheLag(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocateAt("c1", 10*gb, mbps200)

	r.pass(t)

	if got := r.enforcing(t, "c1"); got != 10*gb-band200 {
		t.Errorf("panel is enforcing %d, want %d (10 GB less 875 MB)", got, 10*gb-band200)
	}
}

func TestAnIdleConfigKeepsItsWholeShare(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocateAt("c1", 10*gb, 0)

	r.pass(t)

	if got := r.enforcing(t, "c1"); got != 10*gb {
		t.Errorf("panel is enforcing %d, want the whole %d: no rate, no lag to cover", got, 10*gb)
	}
}

// Never below what the config served: a band wider than what is left cuts
// the config now, and never asks the panel for a figure its counter is past.
func TestTheBandNeverGoesBelowWhatWasServed(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocateAt("c1", 5*gb, 0)
	r.pass(t) // adopt the counter

	r.panel.Serve("c1", 0, 5*gb-100_000_000) // 100 MB left, under the 875 MB band
	r.allocateAt("c1", 5*gb, mbps200)
	r.pass(t)

	if got := r.enforcing(t, "c1"); got != 5*gb-100_000_000 {
		t.Errorf("panel is enforcing %d, want %d: what it served, not 5 GB less the band", got, 5*gb-100_000_000)
	}
}

// A rate that moves a little is not a write: every active config's rate moves
// every pass, and a write per config per pass is a flood on a panel we do not
// own (invariant 34). The panel's band may sit between 1x and 1.25x the
// measured one — always inside the bag, never outside it.
func TestASmallDropInRateIsNotAWriteAndAnyRiseIs(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocateAt("c1", 10*gb, mbps200)
	r.pass(t)
	held := r.enforcing(t, "c1")

	r.allocateAt("c1", 10*gb, mbps200*9/10)
	if report := r.pass(t); report.Written != 0 {
		t.Errorf("a 10%% drop wrote %d: %+v", report.Written, report.Findings)
	}
	if got := r.enforcing(t, "c1"); got != held {
		t.Errorf("panel moved to %d, want it left at %d", got, held)
	}

	r.allocateAt("c1", 10*gb, mbps200*11/10)
	if report := r.pass(t); report.Written != 1 {
		t.Fatalf("a 10%% rise wrote %d, want 1: the old band no longer covers the lag", report.Written)
	}
	if got := r.enforcing(t, "c1"); got != 10*gb-band200*11/10 {
		t.Errorf("panel is enforcing %d, want %d", got, 10*gb-band200*11/10)
	}

	r.allocateAt("c1", 10*gb, mbps200/2)
	if report := r.pass(t); report.Written != 1 {
		t.Errorf("halving the rate wrote %d, want 1: the stale band strands bytes the user bought", report.Written)
	}
}

// A top-up is never absorbed by the tolerance: the smallest block is 60 s of
// rate, more than the 35 s band's quarter.
func TestATopUpUnderTheBandIsStillWritten(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocateAt("c1", 10*gb, mbps200)
	r.pass(t)

	r.allocateAt("c1", 10*gb+25_000_000*60, mbps200)
	if report := r.pass(t); report.Written != 1 {
		t.Fatalf("a 60 s top-up wrote %d, want 1", report.Written)
	}
}
