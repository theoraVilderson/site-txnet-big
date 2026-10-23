package usermanager

import (
	"context"
	"net/url"
	"os"
	"testing"
	"time"

	"network-service/internal/driver"
)

// TestOnARealRouter runs the driver against a real RouterOS v7 with User
// Manager — the dev CHR (dev-docker/routeros, F-1601-e) — so the wire shapes
// the far end above scripts are the ones a router gives. It needs a router
// and is skipped without one:
//
//	USERMANAGER_LIVE_URL=http://<routeros-chr address> \
//	USERMANAGER_LIVE_PASSWORD=<CHR_ADMIN_PASSWORD> go test -run OnARealRouter ./internal/driver/usermanager/
//
// It makes one client of its own and deletes it; nothing else is touched.
func TestOnARealRouter(t *testing.T) {
	base := os.Getenv("USERMANAGER_LIVE_URL")
	if base == "" {
		t.Skip("no router: set USERMANAGER_LIVE_URL (dev-docker/routeros/README.md)")
	}
	d, err := New(base, Credentials{Username: "admin", Password: os.Getenv("USERMANAGER_LIVE_PASSWORD")}, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	caps, err := d.Capabilities(ctx)
	if err != nil {
		t.Fatalf("Capabilities: %v", err)
	}
	if v := caps.Verdict(driver.TransportPush, driver.CounterSession); v.ReviewState != driver.ReviewAccepted {
		t.Fatalf("verdict = %+v, want accepted", v)
	}

	const uuid = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e"
	name := "0f1e2d3c4b5a49688778695a4b3c2d1e"
	t.Cleanup(func() { _ = d.DeleteClient(context.Background(), name) })
	created, err := d.CreateClient(ctx, driver.CreateClientRequest{
		ClaimTag: "txnet-live", UUID: uuid, Protocol: "pppoe", DataLimitBytes: 5 << 30, Enabled: true,
	})
	if err != nil {
		t.Fatalf("CreateClient: %v", err)
	}
	if created.RemoteID != name {
		t.Fatalf("remote id = %q, want %q", created.RemoteID, name)
	}
	// A retry of the same create finishes the chain rather than failing on it.
	if _, err := d.CreateClient(ctx, driver.CreateClientRequest{
		ClaimTag: "txnet-live", UUID: uuid, Protocol: "pppoe", DataLimitBytes: 5 << 30, Enabled: true,
	}); err != nil {
		t.Fatalf("a repeated CreateClient: %v", err)
	}
	if err := d.SetClientDataLimit(ctx, name, 3<<30); err != nil {
		t.Fatalf("SetClientDataLimit: %v", err)
	}
	if err := d.SetClientEnabled(ctx, name, false); err != nil {
		t.Fatalf("SetClientEnabled: %v", err)
	}
	mine := clientNamed(ctx, t, d, name)
	if mine.DataLimitBytes != 3<<30 || mine.Enabled || mine.UUID != uuid || mine.Label != "txnet-live" {
		t.Errorf("listed as %+v, want 3 GiB, disabled, its uuid and claim tag", mine)
	}

	totals, err := d.ClientTotals(ctx)
	if err != nil {
		t.Fatalf("ClientTotals: %v", err)
	}
	found := false
	for _, u := range totals {
		found = found || u.RemoteID == name
	}
	if !found {
		t.Errorf("ClientTotals has no row for %s", name)
	}

	accounts, err := d.ListAccounts(ctx)
	if err != nil {
		t.Fatalf("ListAccounts: %v", err)
	}
	for _, a := range accounts {
		if a.RemoteID == name && (a.UUID != "" || a.InboundRemoteID != chainName(name)) {
			t.Errorf("the source read gave %+v, want no password and its profile", a)
		}
	}

	if err := d.DeleteClient(ctx, name); err != nil {
		t.Fatalf("DeleteClient: %v", err)
	}
	for _, menu := range []string{"user", "profile", "limitation"} {
		key := name
		if menu != "user" {
			key = chainName(name)
		}
		if rows, err := d.list(ctx, "live", menu, url.Values{"name": {key}}); err != nil || len(rows) > 0 {
			t.Errorf("%s %s left after DeleteClient (err %v)", menu, key, err)
		}
	}
}

func clientNamed(ctx context.Context, t *testing.T, d *Driver, name string) driver.RemoteClient {
	t.Helper()
	clients, err := d.ListClients(ctx)
	if err != nil {
		t.Fatalf("ListClients: %v", err)
	}
	for _, c := range clients {
		if c.RemoteID == name {
			return c
		}
	}
	t.Fatalf("ListClients has no %s", name)
	return driver.RemoteClient{}
}
