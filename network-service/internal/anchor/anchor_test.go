package anchor_test

import (
	"context"
	"testing"

	"network-service/internal/anchor"
	"network-service/internal/driver"
	"network-service/internal/driver/fake"
)

// socksFirst is a panel whose first enabled inbound is one the family will not
// create a client on — the dev x-ui panel on 2026-10-14, whose anchor every
// pass failed to plant until Create passed it over.
type socksFirst struct{ *fake.Panel }

func (p socksFirst) ListInbounds(ctx context.Context) ([]driver.Inbound, error) {
	listed, err := p.Panel.ListInbounds(ctx)
	return append([]driver.Inbound{{RemoteID: "s", Protocol: "socks", Enabled: true}}, listed...), err
}

func (p socksFirst) CreateClient(ctx context.Context, req driver.CreateClientRequest) (driver.RemoteClient, error) {
	if req.Protocol == "socks" {
		return driver.RemoteClient{}, &driver.Fault{Kind: driver.FaultUnsupported, Op: "CreateClient"}
	}
	return p.Panel.CreateClient(ctx, req)
}

func TestAnInboundTheFamilyWillNotTakeIsPassedOver(t *testing.T) {
	p := socksFirst{fake.New(fake.Config{})}
	a, err := anchor.Plant(context.Background(), p)
	if err != nil || !a.Planted() {
		t.Fatalf("Plant = %+v, %v; want it planted on the next inbound", a, err)
	}
	clients, _ := p.ListClients(context.Background())
	if c, ok := a.In(clients); !ok || c.InboundRemoteID == "s" {
		t.Fatalf("anchor %+v found %v, want it on an inbound the family takes", c, ok)
	}
}
