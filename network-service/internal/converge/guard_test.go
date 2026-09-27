package converge_test

import (
	"testing"
	"time"

	"network-service/internal/converge"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
)

// The guard band (F-027-co) is off the ceiling pass since F-027-db: the lease
// planner writes the share and budgets the panel's lag itself (rate × Lag in
// its invariant), so a band taken off here would be the lag paid twice, and
// a panel enforcing a figure the planner never wrote would never read as its
// write landing. The band now rides only on the shutdown extension.

const (
	mbps200  = int64(200_000_000) // 25 MB/s
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

// A config seconds from its share, at 25 MB/s on a family with a 35 s lag:
// the panel is written the share itself, not the share less 875 MB.
func TestTheShareIsWrittenAsItIsWhateverTheRate(t *testing.T) {
	r := newRig(t, fake.Config{}, "c1")
	r.panel.Serve("c1", 0, 2*gb-gb/10)
	r.allocateAt("c1", 2*gb, mbps200)

	r.pass(t)

	if got := r.enforcing(t, "c1"); got != 2*gb {
		t.Errorf("panel is enforcing %d, want the share %d", got, 2*gb)
	}
}
