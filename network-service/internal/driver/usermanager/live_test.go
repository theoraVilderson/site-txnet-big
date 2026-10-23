package usermanager

import (
	"context"
	"net/http"
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

	totals, err := d.GetUsage(ctx)
	if err != nil {
		t.Fatalf("GetUsage: %v", err)
	}
	found := false
	for _, u := range totals {
		found = found || u.RemoteID == name
	}
	if !found {
		t.Errorf("GetUsage has no row for %s", name)
	}

	// The import's used (F-1601-f): every user, never above its lifetime.
	current, err := d.AccountUsage(ctx)
	if err != nil {
		t.Fatalf("AccountUsage: %v", err)
	}
	life := map[string]driver.ClientUsage{}
	for _, u := range totals {
		life[u.RemoteID] = u
	}
	if len(current) != len(totals) {
		t.Errorf("AccountUsage read %d users, GetUsage %d", len(current), len(totals))
	}
	for _, u := range current {
		if l := life[u.RemoteID]; u.UpBytes > l.UpBytes || u.DownBytes > l.DownBytes {
			t.Errorf("%s reads %d/%d, above its lifetime %d/%d", u.RemoteID, u.UpBytes, u.DownBytes, l.UpBytes, l.DownBytes)
		}
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

// TestAdoptionOnARealRouter takes a reseller's own user over and hands it
// back on the dev CHR (F-1601-b2): its password is the same row value after
// both, its own profile alone after the hand back. Skipped without a router,
// as TestOnARealRouter is.
func TestAdoptionOnARealRouter(t *testing.T) {
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

	const user, own = "live-adopted", "live-own"
	put := func(menu string, body row) {
		if err := d.call(ctx, "live", http.MethodPut, []string{menu}, nil, body, nil); err != nil {
			t.Fatalf("seeding %s: %v", menu, err)
		}
	}
	t.Cleanup(func() {
		ctx := context.Background()
		_ = d.unlinkProfiles(ctx, "live", user, func(string) bool { return true })
		_ = d.remove(ctx, "live", "user", user)
		_ = d.removeChain(ctx, "live", own)
		_ = d.removeChain(ctx, "live", chainName(user))
	})
	put("limitation", row{"name": own, "transfer-limit": "1000000000"})
	put("profile", row{"name": own, "validity": "unlimited"})
	put("profile-limitation", row{"profile": own, "limitation": own})
	put("user", row{"name": user, "password": "live-secret", "comment": "the reseller's"})
	put("user-profile", row{"user": user, "profile": own})

	if err := d.AdoptClient(ctx, driver.AdoptRequest{RemoteID: user, ClaimTag: "txn-live", DataLimitBytes: 3 << 30, Enabled: true}); err != nil {
		t.Fatalf("AdoptClient: %v", err)
	}
	if got := liveProfiles(ctx, t, d, user); len(got) != 1 || got[0] != chainName(user) {
		t.Fatalf("after adopting, %s holds %v, want our chain alone", user, got)
	}
	if u := liveUser(ctx, t, d, user); u["password"] != "live-secret" || u["comment"] != "txn-live" {
		t.Fatalf("after adopting, %s is %v, want its own password and our tag", user, u)
	}

	if err := d.ReleaseClient(ctx, driver.ReleaseRequest{RemoteID: user, Profile: own, Label: "the reseller's"}); err != nil {
		t.Fatalf("ReleaseClient: %v", err)
	}
	if got := liveProfiles(ctx, t, d, user); len(got) != 1 || got[0] != own {
		t.Fatalf("after the hand back, %s holds %v, want its own profile alone", user, got)
	}
	if u := liveUser(ctx, t, d, user); u["password"] != "live-secret" || u["comment"] != "the reseller's" {
		t.Fatalf("after the hand back, %s is %v, want it as it was", user, u)
	}
	if rows, err := d.list(ctx, "live", "profile", url.Values{"name": {chainName(user)}}); err != nil || len(rows) > 0 {
		t.Fatalf("our profile is left after the hand back (err %v)", err)
	}
}

func liveProfiles(ctx context.Context, t *testing.T, d *Driver, user string) []string {
	t.Helper()
	links, err := d.list(ctx, "live", "user-profile", url.Values{"user": {user}})
	if err != nil {
		t.Fatalf("reading %s's profiles: %v", user, err)
	}
	var out []string
	for _, l := range links {
		out = append(out, l["profile"])
	}
	return out
}

// liveUser reads the whole row, password included: the test's own seeded
// secret, read to prove nothing wrote it.
func liveUser(ctx context.Context, t *testing.T, d *Driver, user string) row {
	t.Helper()
	users, err := d.list(ctx, "live", "user", url.Values{"name": {user}})
	if err != nil || len(users) != 1 {
		t.Fatalf("reading %s: %v (%d rows)", user, err, len(users))
	}
	return users[0]
}
