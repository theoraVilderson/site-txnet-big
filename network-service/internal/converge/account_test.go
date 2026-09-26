package converge_test

import (
	"regexp"
	"testing"

	"network-service/internal/converge"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
)

// One purchase is one account on a panel (F-114-n, contract.provisioning.md
// "One purchase, one account"): every client of a credential group shares a
// subscription key and is named `<key>-<n>`; each keeps its own uuid.

func grouped(configID, inbound, group string) converge.DesiredConfig {
	row := wanted(configID)
	row.InboundRemoteID, row.CredentialGroupID = inbound, group
	return row
}

func twoInbounds() fake.Config {
	return fake.Config{Inbounds: []driver.Inbound{
		{RemoteID: "1", Protocol: "vless", Enabled: true},
		{RemoteID: "2", Protocol: "vless", Enabled: true},
	}}
}

func TestTheSubscriptionKeyIsTheGroupsAndLooksLikeTheFamilysOwn(t *testing.T) {
	a, b := converge.SubscriptionKey("g-1"), converge.SubscriptionKey("g-2")
	if a != converge.SubscriptionKey("g-1") || a == b {
		t.Fatalf("keys %q / %q: want one per group, stable", a, b)
	}
	if !regexp.MustCompile(`^[a-z0-9]{16}$`).MatchString(a) {
		t.Fatalf("key %q is not 16 of [a-z0-9], x-ui's own subId shape", a)
	}
	if converge.SubscriptionKey("") != "" {
		t.Fatal("no group must give no key")
	}
}

func TestEveryClientOfOnePurchaseSharesOneKeyAndOneNameRoot(t *testing.T) {
	r := newProvRig(t, twoInbounds())
	r.desired.Put("panel-1", grouped("c1", "1", "g-1"))
	r.desired.Put("panel-1", grouped("c2", "2", "g-1"))

	r.pass(t)

	key := converge.SubscriptionKey("g-1")
	for id, name := range map[string]string{"c1": key + "-1", "c2": key + "-2"} {
		row := r.row(t, id)
		if row.RemoteID != name {
			t.Fatalf("%s named %q, want %q", id, row.RemoteID, name)
		}
		client, ok := r.client(t, name)
		if !ok || client.UUID != row.UUID {
			t.Fatalf("%s: client %+v, want its own uuid %s", id, client, row.UUID)
		}
		if got := r.panel.SubscriptionKeyOf(name); got != key {
			t.Fatalf("%s carries subscription key %q, want the group's %q", id, got, key)
		}
	}
}

func TestANameAlreadyOnThePanelIsSkippedNotCollidedWith(t *testing.T) {
	r := newProvRig(t, twoInbounds())
	key := converge.SubscriptionKey("g-1")
	r.panel.Given(key + "-1")
	r.desired.Put("panel-1", grouped("c1", "1", "g-1"))

	r.pass(t)

	if got := r.row(t, "c1").RemoteID; got != key+"-2" {
		t.Fatalf("named %q, want %q: -1 is taken", got, key+"-2")
	}
}

func TestAPickAddedLaterJoinsTheSameAccount(t *testing.T) {
	r := newProvRig(t, twoInbounds())
	r.desired.Put("panel-1", grouped("c1", "1", "g-1"))
	r.pass(t)
	r.desired.Put("panel-1", grouped("c2", "2", "g-1"))

	r.pass(t)

	key := converge.SubscriptionKey("g-1")
	if got := r.row(t, "c2").RemoteID; got != key+"-2" {
		t.Fatalf("later pick named %q, want %q", got, key+"-2")
	}
	if got := r.panel.SubscriptionKeyOf(key + "-2"); got != key {
		t.Fatalf("later pick carries %q, want the group's %q", got, key)
	}
}

func TestARecreatedClientKeepsItsName(t *testing.T) {
	r := newProvRig(t, twoInbounds())
	r.desired.Put("panel-1", grouped("c1", "1", "g-1"))
	r.desired.Put("panel-1", grouped("c2", "2", "g-1"))
	r.pass(t)
	name := r.row(t, "c2").RemoteID
	r.panel.Remove(name)

	r.pass(t)

	if got := r.row(t, "c2").RemoteID; got != name {
		t.Fatalf("recreated as %q, want its old name %q", got, name)
	}
}

func TestAConfigOfNoGroupIsNamedAsTheFamilyNamesIt(t *testing.T) {
	r := newProvRig(t, twoInbounds())
	r.desired.Put("panel-1", grouped("c1", "1", ""))

	r.pass(t)

	name := r.row(t, "c1").RemoteID
	if name == "" || r.panel.SubscriptionKeyOf(name) != "" {
		t.Fatalf("named %q with key %q, want the family's default and no key", name, r.panel.SubscriptionKeyOf(name))
	}
}
