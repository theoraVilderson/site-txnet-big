package converge_test

import (
	"context"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/converge"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
)

// The guard band (F-027-co): a panel cuts a client some seconds after it
// crosses its ceiling — 3x-ui checks traffic every 5 s and restarts Xray for
// up to 30 s more — and everything served in that lag lands past the share,
// billed by nobody. So the ceiling written is the share less what the config's
// own measured rate carries in that lag, and the overrun falls inside the bag.
//
// Only near the cut (F-027-cq): a config more than the hot horizon (120 s) of
// its own rate from its share keeps the whole share, so a rate that moves is
// no write; and a config quiet inside its band gets the band back, so what a
// prepaid user bought is not stranded behind a rate nobody will re-measure.
// At 25 MB/s the horizon is 3 GB.

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
	r.allocateAt("c1", 2*gb, mbps200)

	r.pass(t)

	if got := r.enforcing(t, "c1"); got != 2*gb-band200 {
		t.Errorf("panel is enforcing %d, want %d (2 GB less 875 MB)", got, 2*gb-band200)
	}
}

func TestAnIdleConfigKeepsItsWholeShare(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocateAt("c1", 2*gb, 0)

	r.pass(t)

	if got := r.enforcing(t, "c1"); got != 2*gb {
		t.Errorf("panel is enforcing %d, want the whole %d: no rate, no lag to cover", got, 2*gb)
	}
}

// Far from the cut the band buys nothing: the panel's lag only matters at the
// moment it cuts, and a far config reaches it through the near window first.
func TestAFarConfigKeepsItsWholeShareWhateverItsRate(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocateAt("c1", 10*gb, mbps200)
	r.pass(t)
	if got := r.enforcing(t, "c1"); got != 10*gb {
		t.Fatalf("panel is enforcing %d, want the whole %d: 10 GB is past the 3 GB horizon", got, 10*gb)
	}

	for _, rate := range []int64{mbps200 * 3 / 2, mbps200 / 3, mbps200 * 2} {
		r.allocateAt("c1", 10*gb, rate)
		if report := r.pass(t); report.Written != 0 {
			t.Errorf("rate %d on a far config wrote %d: %+v", rate, report.Written, report.Findings)
		}
	}
}

func TestAConfigComingNearGetsItsBand(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocateAt("c1", 4*gb, mbps200)
	r.pass(t) // adopt; 4 GB is far
	if got := r.enforcing(t, "c1"); got != 4*gb {
		t.Fatalf("panel is enforcing %d, want the whole %d while far", got, 4*gb)
	}

	r.panel.Serve("c1", 0, 2*gb) // 2 GB left: inside the 3 GB horizon
	if report := r.pass(t); report.Written != 1 {
		t.Fatalf("coming near wrote %d, want 1", report.Written)
	}
	if got := r.enforcing(t, "c1"); got != 4*gb-band200 {
		t.Errorf("panel is enforcing %d, want %d", got, 4*gb-band200)
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

// Cut inside its band and quiet since, a config gets the band back: its rate
// is never measured again while it cannot move, so the band would otherwise
// strand the last seconds of what was bought for good.
func TestAQuietConfigInsideItsBandGetsTheBandBack(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocateAt("c1", 5*gb, 0)
	r.pass(t)
	r.panel.Serve("c1", 0, 5*gb-100_000_000)
	r.allocateAt("c1", 5*gb, mbps200)
	r.pass(t) // cut at what it served

	if report := r.pass(t); report.Written != 1 {
		t.Fatalf("a quiet pass wrote %d, want 1: the band is released", report.Written)
	}
	if got := r.enforcing(t, "c1"); got != 5*gb {
		t.Errorf("panel is enforcing %d, want the whole %d", got, 5*gb)
	}
	if report := r.pass(t); report.Written != 0 {
		t.Errorf("a second quiet pass wrote %d, want 0", report.Written)
	}
}

// A woken turn reads no usage, so no delta is not quiet there: releasing on
// it would lift the cut while the panel's lag is still running.
func TestAConvergenceOnlyTurnIsNotQuiet(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocateAt("c1", 5*gb, 0)
	r.pass(t)
	r.panel.Serve("c1", 0, 5*gb-100_000_000)
	r.allocateAt("c1", 5*gb, mbps200)
	r.pass(t)

	res := collect.Result{PanelID: "panel-1", ObservedAt: time.Now().Add(time.Hour)}
	report, err := r.reports.ceilings.Pass(context.Background(), r.panelRow(), res)
	if err != nil {
		t.Fatal(err)
	}
	if report.Written != 0 {
		t.Errorf("a turn that read no usage released the band: %+v", report.Findings)
	}
}

// A rate that moves a little near the cut is not a write: the panel's band may
// sit between 1x and 1.25x the measured one — always inside the bag.
func TestASmallDropInRateIsNotAWriteAndAnyRiseIs(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocateAt("c1", 2*gb, mbps200)
	r.pass(t)
	held := r.enforcing(t, "c1")

	r.allocateAt("c1", 2*gb, mbps200*9/10)
	if report := r.pass(t); report.Written != 0 {
		t.Errorf("a 10%% drop wrote %d: %+v", report.Written, report.Findings)
	}
	if got := r.enforcing(t, "c1"); got != held {
		t.Errorf("panel moved to %d, want it left at %d", got, held)
	}

	r.allocateAt("c1", 2*gb, mbps200*11/10)
	if report := r.pass(t); report.Written != 1 {
		t.Fatalf("a 10%% rise wrote %d, want 1: the old band no longer covers the lag", report.Written)
	}
	if got := r.enforcing(t, "c1"); got != 2*gb-band200*11/10 {
		t.Errorf("panel is enforcing %d, want %d", got, 2*gb-band200*11/10)
	}
}

// A top-up is never absorbed by the tolerance: the smallest block is 60 s of
// rate, more than the 35 s band's quarter.
func TestATopUpUnderTheBandIsStillWritten(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.allocateAt("c1", 2*gb, mbps200)
	r.pass(t)

	r.allocateAt("c1", 2*gb+25_000_000*60, mbps200)
	if report := r.pass(t); report.Written != 1 {
		t.Fatalf("a 60 s top-up wrote %d, want 1", report.Written)
	}
}

func (r *rig) panelRow() collect.Panel {
	panels, _ := r.loop.Source.Panels(context.Background())
	return panels[0]
}
