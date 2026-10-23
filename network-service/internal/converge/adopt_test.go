package converge_test

import (
	"testing"

	"network-service/internal/converge"
	"network-service/internal/driver/fake"
)

// An adopted login (F-1601-b2, ADR-0160): a reseller's user imported in place
// keeps its own credential on the router. The pass takes it over under our
// ceiling, never writes or replaces that credential, and never makes it again.

// adoptedRig is a router holding the reseller's user `ali`, and the config an
// in-place import made for it: the user's name as its id, a uuid of ours the
// router never sees.
func adoptedRig(t *testing.T) (*provRig, converge.DesiredConfig) {
	t.Helper()
	r := newProvRig(t, fake.Config{})
	r.panel.Holds("ali", "ali-ppp-secret", "Ali R.", "monthly-20G")
	row := wanted("c1")
	row.RemoteID, row.AdoptedProfile, row.AdoptedLabel = "ali", "monthly-20G", "Ali R."
	r.desired.Put("panel-1", row)
	return r, row
}

func TestAnAdoptedLoginIsTakenOverAndItsCredentialNeverWritten(t *testing.T) {
	r, _ := adoptedRig(t)

	onlyAction(t, r.pass(t), converge.ActionAdoptedInPlace)
	client, _ := r.client(t, "ali")
	if client.UUID != "ali-ppp-secret" || client.Label != "tag-c1" || r.panel.ProfileOf("ali") != fake.AdoptedProfile("ali") {
		t.Fatalf("ali is %+v on %q, want its own credential, our tag and our profile", client, r.panel.ProfileOf("ali"))
	}
	// The link starts the router's counter at zero (F-1601-e): the first
	// ceiling is the whole allocation, nothing the user used before.
	if client.DataLimitBytes != 10*gb {
		t.Fatalf("first ceiling %d, want the allocation %d", client.DataLimitBytes, 10*gb)
	}
	if got := r.row(t, "c1"); got.State != converge.StatePartial {
		t.Fatalf("state after adopting = %s, want partial until a read confirms it", got.State)
	}

	r.pass(t)
	if n := r.panel.CallCount("UpdateClient") + r.panel.CallCount("CreateClient"); n != 0 {
		t.Fatalf("%d credential writes to an adopted login, want none: its uuid is never the router's", n)
	}
	if got := r.row(t, "c1"); got.State != converge.StateComplete {
		t.Fatalf("state after the confirming read = %s, want complete", got.State)
	}
}

func TestAnAdoptedLoginWaitsForItsAllocation(t *testing.T) {
	r, row := adoptedRig(t)
	row.AllocatedBytes = nil
	r.desired.Put("panel-1", row)

	onlyAction(t, r.pass(t), converge.ActionAwaitingAllocation)
	if r.panel.CallCount("AdoptClient") != 0 || r.panel.ProfileOf("ali") != "monthly-20G" {
		t.Fatal("an adoption went out with no ceiling to put the user under")
	}
}

func TestAnAdoptedLoginGoneIsNeverMadeAgain(t *testing.T) {
	r, row := adoptedRig(t)
	r.panel.Remove("ali")
	r.desired.Put("panel-1", row)

	onlyAction(t, r.pass(t), converge.ActionLoginGone)
	if r.panel.CallCount("CreateClient") != 0 {
		t.Fatal("a login of the router's own was made again under a credential of ours")
	}
}

func TestARolledBackLoginIsHandedBackNotDeleted(t *testing.T) {
	r, row := adoptedRig(t)
	r.pass(t)

	row = r.row(t, "c1")
	row.Present, row.HandBack = false, true
	r.desired.Put("panel-1", row)
	onlyAction(t, r.pass(t), converge.ActionHandedBack)
	client, ok := r.client(t, "ali")
	if !ok || client.Label != "Ali R." || client.UUID != "ali-ppp-secret" || r.panel.ProfileOf("ali") != "monthly-20G" {
		t.Fatalf("ali is %+v (present %v) on %q, want it kept as imported", client, ok, r.panel.ProfileOf("ali"))
	}

	r.pass(t)
	if got := r.row(t, "c1"); got.RemoteID != "" || got.State != converge.StateComplete {
		t.Fatalf("after the confirming read the row is %q/%s, want no id and complete", got.RemoteID, got.State)
	}
	if r.panel.CallCount("DeleteClient") != 0 {
		t.Fatal("a handed-back user was deleted")
	}
}

func TestAnAdoptedLoginAtANormalEndIsDeleted(t *testing.T) {
	r, row := adoptedRig(t)
	r.pass(t)

	row = r.row(t, "c1")
	row.Present = false
	r.desired.Put("panel-1", row)
	onlyAction(t, r.pass(t), converge.ActionDeleted)
	if _, ok := r.client(t, "ali"); ok {
		t.Fatal("an adopted login at its normal end is still on the router (ADR-0160 decision 8)")
	}
}
