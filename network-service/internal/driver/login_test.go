package driver

import (
	"strings"
	"testing"
)

// x-ui answers "wrong username or password" whenever its user lookup fails,
// and a locked SQLite fails it. Credentials that worked on this driver are
// therefore not called refused until the refusal repeats.
func TestARefusedLoginIsBlockedOnlyOnceItRepeats(t *testing.T) {
	var r LoginRefusals
	if got := r.Refused("GetUsage", 200, "wrong username or password"); got.Kind != FaultBlocked {
		t.Fatalf("credentials that never worked: %s, want blocked", got.Kind)
	}

	r = LoginRefusals{}
	r.Succeeded()
	for i := 1; i < LoginRefusalsToBlock; i++ {
		if got := r.Refused("GetUsage", 200, "wrong username or password"); got.Kind != FaultUnavailable {
			t.Fatalf("refusal %d of credentials that worked: %s, want unavailable", i, got.Kind)
		}
	}
	if got := r.Refused("GetUsage", 200, "wrong username or password"); got.Kind != FaultBlocked {
		t.Fatalf("refusal %d in a row: %s, want blocked", LoginRefusalsToBlock, got.Kind)
	}

	r.Succeeded()
	if got := r.Refused("GetUsage", 200, "wrong username or password"); got.Kind != FaultUnavailable {
		t.Fatalf("a login that worked restarts the count: %s, want unavailable", got.Kind)
	}
}

func TestALockedPanelDatabaseIsUnavailable(t *testing.T) {
	if got := RefusalFault("GetUsage", 200, "Obtain Failed: database is locked"); got.Kind != FaultUnavailable {
		t.Errorf("database is locked: %s, want unavailable", got.Kind)
	}
	if got := RefusalFault("GetUsage", 200, "inbound not found"); got.Kind != FaultProtocol {
		t.Errorf("any other refusal: %s, want protocol", got.Kind)
	}
	if got := RefusalFault("GetUsage", 200, "inbound not found").Error(); !strings.Contains(got, "panel refused: inbound not found") {
		t.Errorf("the refusal reads %q, want the panel's message kept", got)
	}
}
