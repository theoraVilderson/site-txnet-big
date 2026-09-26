package converge_test

import (
	"context"
	"testing"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
)

// The collector guard (F-027-cf, ADR-0090 decision 1). A panel whose address
// was re-pointed after registration answers with another panel's clients: our
// tags are global (invariant 17), so one of them on this panel is proof that
// the server behind the address is not the one our configs are on. The pass
// stops before it writes anything and raises a halting event naming both.

// foreignRig is the containment rig with a second panel's config in the same
// store, and the guard wired to it.
func foreignRig(t *testing.T) *containRig {
	t.Helper()
	r := newContainRig(t)
	r.conv.conv.Provisioning.Claims = r.desired
	r.conv.conv.Provisioning.Events = r.events
	r.desired.Put("panel-2", wanted("c9"))
	return r
}

// plant puts a client on panel-1 the way panel-2's pass made it on its own
// server: under c9's tag and credential.
func (r *containRig) plant(t *testing.T, tag, uuid string) string {
	t.Helper()
	c, err := r.panel.CreateClient(context.Background(), driver.CreateClientRequest{
		UUID: uuid, ClaimTag: tag, InboundRemoteID: "inbound-1", Enabled: true,
	})
	if err != nil {
		t.Fatalf("plant: %v", err)
	}
	return c.RemoteID
}

func TestAPanelHoldingAnotherPanelsClientStopsAndNamesBoth(t *testing.T) {
	for _, tc := range []struct {
		name      string
		tag, uuid string
	}{
		{"by claim tag", "tag-c9", "somebody-elses-uuid"},
		{"by uuid alone, rebuilt without its tag", "", "uuid-c9"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := foreignRig(t)
			r.established(t)

			// Re-pointed: our client is not on this server, panel-2's is.
			r.panel.Remove("remote-1")
			r.plant(t, tc.tag, tc.uuid)
			creates := r.panel.CallCount("CreateClient")
			r.pass(t)

			events := r.events.Events("panel-1")
			if len(events) != 1 {
				t.Fatalf("events = %+v, want one", events)
			}
			e := events[0]
			if e.Type != collect.ForeignClaim || e.ForeignPanelID != "panel-2" || !e.CollectionHalted ||
				e.Affected != 1 || e.Observed != 1 {
				t.Fatalf("event = %+v, want a halting foreign_claim naming panel-2, 1 of 1 clients", e)
			}
			if r.panel.CallCount("CreateClient") != creates {
				t.Fatal("c1 was recreated on a server that is not panel-1's: the guard runs before any write")
			}

			// Stopped: neither read nor converged while the event is open.
			reads, lists := r.panel.CallCount("GetUsage"), r.panel.CallCount("ListClients")
			r.at = r.at.Add(time.Minute)
			report, err := r.loop.Pass(context.Background())
			if err != nil {
				t.Fatalf("pass: %v", err)
			}
			if len(report.Failed) != 1 || report.Failed[0].Op != collect.OpHalted {
				t.Fatalf("failed = %+v, want the stopped panel reported, not silent", report.Failed)
			}
			if r.panel.CallCount("GetUsage") != reads || r.panel.CallCount("ListClients") != lists {
				t.Fatal("a panel answering for another server was read or converged while stopped")
			}

			// The address is put right and the event acknowledged: converged
			// again, and nothing raised twice.
			r.panel.Remove("remote-2")
			r.events.Acknowledge("panel-1", r.at)
			r.pass(t)
			if r.panel.CallCount("CreateClient") != creates+1 {
				t.Fatal("c1 was not recreated once the panel was ours again")
			}
			if len(r.events.Events("panel-1")) != 1 {
				t.Fatal("a panel holding only its own clients raised the alarm again")
			}
		})
	}
}

func TestAClientNobodyClaimsAnywhereIsOnlyAnOrphan(t *testing.T) {
	r := foreignRig(t)
	r.established(t)
	r.panel.Given("stranger")

	report := r.pass(t)

	if got := report.Provisioning.Orphans; len(got) != 1 || got[0] != "stranger" {
		t.Fatalf("orphans = %v, want [stranger]", got)
	}
	if events := r.events.Events("panel-1"); len(events) != 0 {
		t.Fatalf("events = %+v: a panel's own users are not another panel's", events)
	}
}
