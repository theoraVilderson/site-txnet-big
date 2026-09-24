package hiddify

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"network-service/internal/driver"
	"network-service/internal/driver/conformance"
)

const (
	adminPath = "/adm1n"
	// clientPath is the client proxy path users are served under (F-027-bg).
	clientPath = "/cl1ent"
	apiKey     = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0"
)

// farEnd is a scripted Hiddify Manager: the v2 admin API under the panel's
// admin proxy path, in Hiddify's shapes. It holds bytes, as Hiddify's columns
// do, and answers them as GB (1024³) floats, as Hiddify's schema does, so a
// driver that rounds the conversion fails every exact-byte scenario.
type farEnd struct {
	t *testing.T

	mu      sync.Mutex
	users   []*farUser
	backup  []farUser
	nextID  int
	calls   int
	lists   int
	patches []map[string]any
	key     string
	// clientKeys is every Hiddify-API-Key header the client path was sent.
	clientKeys []string

	nextStall    time.Duration
	nextStatus   int
	ceilingDelay int
}

type farUser struct {
	ID          int
	UUID        string
	Name        string
	Comment     string
	Usage       int64
	Limit       int64
	PackageDays int
	StartDate   string
	Mode        string
	Enable      bool

	pending      *int64
	pendingReads int
}

func newFarEnd(t *testing.T) *farEnd {
	return &farEnd{t: t, key: apiKey, nextID: 1}
}

func (f *farEnd) byUUID(uuid string) *farUser {
	for _, u := range f.users {
		if u.UUID == uuid {
			return u
		}
	}
	return nil
}

func (f *farEnd) byName(name string) *farUser {
	for _, u := range f.users {
		if u.Name == name {
			return u
		}
	}
	return nil
}

func (f *farEnd) add(u *farUser) {
	u.ID = f.nextID
	f.nextID++
	f.users = append(f.users, u)
}

func (f *farEnd) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.calls++
	stall, status := f.nextStall, f.nextStatus
	f.nextStall, f.nextStatus = 0, 0
	key := f.key
	f.mu.Unlock()

	if stall > 0 {
		select {
		case <-time.After(stall):
		case <-r.Context().Done():
			return
		}
	}
	if status != 0 {
		if status == http.StatusTooManyRequests {
			w.Header().Set("Retry-After", "7")
		}
		http.Error(w, `{"message":"scripted"}`, status)
		return
	}
	// The client proxy path serves a user's links by uuid, with no key.
	if strings.HasPrefix(r.URL.Path, clientPath+"/") {
		f.serveClient(w, r)
		return
	}
	// Hiddify answers an unknown key with its logout redirect, not a 401.
	if r.Header.Get("Hiddify-API-Key") != key {
		http.Redirect(w, r, adminPath+"/admin/", http.StatusFound)
		return
	}
	prefix := adminPath + "/api/v2/admin/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		http.NotFound(w, r)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, prefix)

	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.Method == http.MethodGet && path == "me/":
		writeJSON(w, map[string]any{"uuid": apiKey, "name": "owner", "mode": "super_admin"})
	case r.Method == http.MethodGet && path == "user/":
		f.lists++
		if len(f.users) == 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"detail":{},"message":"You have no user"}`))
			return
		}
		out := make([]map[string]any, 0, len(f.users))
		for _, u := range f.users {
			out = append(out, u.wire())
			// A delayed ceiling is taken after the read that counts it down.
			if u.pending != nil {
				if u.pendingReads--; u.pendingReads <= 0 {
					u.Limit, u.pending = *u.pending, nil
				}
			}
		}
		writeJSON(w, out)
	case r.Method == http.MethodPost && path == "user/":
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"message":"bad body"}`, http.StatusBadRequest)
			return
		}
		if uuid, _ := body["uuid"].(string); uuid != "" && f.byUUID(uuid) != nil {
			http.Error(w, `{"message":"The user exists"}`, http.StatusBadRequest)
			return
		}
		// Hiddify's defaults for what a create leaves out.
		u := &farUser{Limit: 1000 << 30, PackageDays: 90, Mode: "no_reset", Enable: true}
		f.apply(u, body)
		f.add(u)
		writeJSON(w, u.wire())
	case strings.HasPrefix(path, "user/") && strings.HasSuffix(path, "/"):
		uuid := strings.TrimSuffix(strings.TrimPrefix(path, "user/"), "/")
		u := f.byUUID(uuid)
		if u == nil {
			http.Error(w, `{"message":"user not found"}`, http.StatusNotFound)
			return
		}
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, u.wire())
		case http.MethodPatch:
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, `{"message":"bad body"}`, http.StatusBadRequest)
				return
			}
			f.patches = append(f.patches, body)
			if gb, ok := body["usage_limit_GB"].(float64); ok && f.ceilingDelay > 0 {
				b := int64(gb * (1 << 30))
				u.pending, u.pendingReads = &b, f.ceilingDelay
				f.ceilingDelay = 0
				delete(body, "usage_limit_GB")
			}
			// add_or_update(old_uuid=…): the same row, its uuid changed in place.
			f.apply(u, body)
			writeJSON(w, u.wire())
		case http.MethodDelete:
			for i, have := range f.users {
				if have == u {
					f.users = append(f.users[:i], f.users[i+1:]...)
					break
				}
			}
			writeJSON(w, map[string]any{"status": 200, "msg": "ok"})
		default:
			http.Error(w, `{"message":"method"}`, http.StatusMethodNotAllowed)
		}
	default:
		http.NotFound(w, r)
	}
}

// apply is add_or_update: a field is written only when present and not null,
// and start_date only beside package_days. The GB setters multiply by 1024³.
// serveClient is `<client path>/<uuid>/sub/`: the user's links in plain
// text, one per protocol, as Hiddify's user view answers them.
func (f *farEnd) serveClient(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.clientKeys = append(f.clientKeys, r.Header.Get("Hiddify-API-Key"))
	uuid, rest, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, clientPath+"/"), "/")
	u := f.byUUID(uuid)
	if u == nil || rest != "sub/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	_, _ = w.Write([]byte("vmess://eyJhZGQiOiJjZG4uZXhhbXBsZS5uZXQifQ==\n" +
		"vless://" + u.UUID + "@cdn.example.net:443?security=tls#" + u.Name + "\n" +
		"trojan://" + u.UUID + "@cdn.example.net:443?security=tls#" + u.Name + "\n"))
}

func (f *farEnd) apply(u *farUser, b map[string]any) {
	if v, ok := b["uuid"].(string); ok && v != "" {
		u.UUID = v
	}
	if v, ok := b["name"].(string); ok {
		u.Name = v
	}
	if v, ok := b["comment"].(string); ok {
		u.Comment = v
	}
	if v, ok := b["package_days"].(float64); ok {
		u.PackageDays = int(v)
		if s, ok := b["start_date"].(string); ok {
			u.StartDate = s
		}
	}
	if v, ok := b["current_usage_GB"].(float64); ok {
		u.Usage = int64(v * (1 << 30))
	}
	if v, ok := b["usage_limit_GB"].(float64); ok {
		u.Limit = int64(v * (1 << 30))
	}
	if v, ok := b["enable"].(bool); ok {
		u.Enable = v
	}
	if v, ok := b["mode"].(string); ok {
		u.Mode = v
	}
}

func (u *farUser) wire() map[string]any {
	var start any
	if u.StartDate != "" {
		start = u.StartDate
	}
	return map[string]any{
		"id": u.ID, "uuid": u.UUID, "name": u.Name, "comment": u.Comment,
		"current_usage_GB": float64(u.Usage) / (1 << 30),
		"usage_limit_GB":   float64(u.Limit) / (1 << 30),
		"package_days":     u.PackageDays, "start_date": start, "mode": u.Mode,
		"enable": u.Enable, "is_active": u.Enable && u.Usage <= u.Limit,
		"wg_pk": "k", "ed25519_public_key": "p", "lang": "en",
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

type harness struct {
	f *farEnd
	d *Driver
}

func (h *harness) Driver() driver.Driver { return h.d }

func (h *harness) Given(remoteID string) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.add(&farUser{
		UUID: "uuid-" + remoteID, Name: remoteID, Limit: 1000 << 30,
		PackageDays: 10000, StartDate: "2026-01-01", Mode: "no_reset", Enable: true,
	})
}

func (h *harness) Serve(remoteID string, up, down int64) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.byName(remoteID).Usage += up + down
}

func (h *harness) ZeroCounter(remoteID string) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.byName(remoteID).Usage = 0
}

func (h *harness) TakeBackup() {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.backup = nil
	for _, u := range h.f.users {
		h.f.backup = append(h.f.backup, *u)
	}
}

func (h *harness) RestoreBackup() {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.users = nil
	for _, u := range h.f.backup {
		restored := u
		h.f.users = append(h.f.users, &restored)
	}
}

func (h *harness) StallNextCall(d time.Duration) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.nextStall = d
}

func (h *harness) FailNextCall(status int) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.nextStatus = status
}

func (h *harness) AbandonSession(string) { h.f.t.Fatal("a Hiddify panel has no sessions") }

func (h *harness) DelayCeilingBy(reads int) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.ceilingDelay = reads
}

func (h *harness) TotalCalls() int {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	return h.f.calls
}

var fixedNow = time.Date(2026, 9, 24, 21, 0, 0, 0, time.UTC)

func open(t *testing.T) (*farEnd, *Driver) {
	t.Helper()
	f := newFarEnd(t)
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	d, err := New(srv.URL+adminPath, srv.URL+clientPath, apiKey, srv.Client())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	d.now = func() time.Time { return fixedNow }
	if err := d.HealthCheck(context.Background()); err != nil {
		t.Fatalf("HealthCheck: %v", err)
	}
	return f, d
}

// TestConformance: pull, cumulative, with a per-user ceiling. Every push and
// no-ceiling scenario is skipped by name.
func TestConformance(t *testing.T) {
	conformance.Run(t, func(t *testing.T, shape conformance.Shape) (conformance.Harness, bool) {
		if shape.Transport != driver.TransportPull || shape.CounterSemantics != driver.CounterCumulative || !shape.CeilingSupported {
			return nil, false
		}
		f, d := open(t)
		return &harness{f: f, d: d}, true
	})
}

// The row's own question (data_limit_counts_the_same_bytes): Hiddify reports
// usage and limit in GB. A GB is 1024³ bytes and the figure is a float64,
// which holds every byte count below 2^53 exactly, so an odd byte count must
// cross both ways with nothing lost — or a block bought against the cursor is
// spent against a different number.
func TestGigabytesCarryEveryByte(t *testing.T) {
	f, d := open(t)
	ctx := context.Background()
	(&harness{f: f, d: d}).Given("c1")
	const odd = int64(5<<30) + 123_456_789

	f.mu.Lock()
	f.byName("c1").Usage = odd
	f.mu.Unlock()
	usage, err := d.GetUsage(ctx)
	if err != nil || len(usage) != 1 {
		t.Fatalf("GetUsage = %v, %v", usage, err)
	}
	if usage[0].DownBytes != odd || usage[0].UpBytes != 0 {
		t.Errorf("usage = %d up / %d down, want 0 / %d: the GB figure lost bytes", usage[0].UpBytes, usage[0].DownBytes, odd)
	}

	if err := d.SetClientDataLimit(ctx, "c1", odd+1); err != nil {
		t.Fatalf("SetClientDataLimit: %v", err)
	}
	f.mu.Lock()
	limit, mode := f.byName("c1").Limit, f.byName("c1").Mode
	f.mu.Unlock()
	if limit != odd+1 {
		t.Errorf("the panel holds a ceiling of %d bytes, want %d", limit, odd+1)
	}
	if mode != "no_reset" {
		t.Errorf("mode = %q after a ceiling write, want no_reset: any other mode zeroes the counter on Hiddify's schedule", mode)
	}
	clients, err := d.ListClients(ctx)
	if err != nil || len(clients) != 1 || clients[0].DataLimitBytes != odd+1 {
		t.Errorf("ListClients = %+v, %v: the ceiling does not read back byte for byte", clients, err)
	}
}

// A zero ceiling is a real zero on Hiddify (add_or_update tests `is not
// None`), so it is written as 0 and never left out: a missing limit is
// Hiddify's 1000 GB default.
func TestZeroCeilingIsWrittenNotOmitted(t *testing.T) {
	f, d := open(t)
	(&harness{f: f, d: d}).Given("c1")
	if err := d.SetClientDataLimit(context.Background(), "c1", 0); err != nil {
		t.Fatalf("SetClientDataLimit(0): %v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if got := f.byName("c1").Limit; got != 0 {
		t.Errorf("a zero ceiling reached the panel as %d bytes", got)
	}
	if _, sent := f.patches[len(f.patches)-1]["usage_limit_GB"]; !sent {
		t.Error("usage_limit_GB was left out of the write")
	}
}

// A client is created under its name, claim tag, first block and expiry, and
// every matching key reads back.
func TestCreateClientRoundTrip(t *testing.T) {
	f, d := open(t)
	ctx := context.Background()
	expires := time.Date(2026, 12, 1, 15, 30, 0, 0, time.UTC)

	created, err := d.CreateClient(ctx, driver.CreateClientRequest{
		ClaimTag: "cfg_7f3a", UUID: "8a3c1e2b-0000-4000-8000-00000000abcd", InboundRemoteID: "vless",
		Protocol: "vless", DataLimitBytes: 5 << 30, ExpiresAt: expires, Enabled: false,
	})
	if err != nil {
		t.Fatalf("CreateClient: %v", err)
	}
	if created.RemoteID != "8a3c1e2b00004000800000000000abcd" {
		t.Errorf("remote id = %q, want the uuid without hyphens", created.RemoteID)
	}
	clients, err := d.ListClients(ctx)
	if err != nil || len(clients) != 1 {
		t.Fatalf("ListClients = %v, %v", clients, err)
	}
	c := clients[0]
	if c.RemoteID != created.RemoteID || c.Label != "cfg_7f3a" || c.UUID != "8a3c1e2b-0000-4000-8000-00000000abcd" {
		t.Errorf("client = %+v: a matching key did not survive the round trip (F-027-aa)", c)
	}
	if c.Enabled || c.DataLimitBytes != 5<<30 {
		t.Errorf("enabled/limit = %v/%d, want false/%d", c.Enabled, c.DataLimitBytes, int64(5<<30))
	}
	// Never before ours, at most a day and a bit after it.
	if c.ExpiresAt.Before(expires) || c.ExpiresAt.After(expires.Add(36*time.Hour)) {
		t.Errorf("expiry = %s, want on or just after %s", c.ExpiresAt, expires)
	}
	f.mu.Lock()
	u := f.byName(created.RemoteID)
	f.mu.Unlock()
	if u.Mode != "no_reset" || u.StartDate != "2026-09-24" || u.PackageDays != 69 {
		t.Errorf("mode/start/days = %s/%s/%d, want no_reset/2026-09-24/69 (served through 2026-12-02)", u.Mode, u.StartDate, u.PackageDays)
	}
}

// Hiddify counts expiry in whole days from start_date, on the server's date.
// The day written is the one after ours, and it reads back as the last second
// before it, so carrying the read-back through an update writes the same day
// again instead of creeping a day each time.
func TestExpiryIsNeverEarlyAndDoesNotCreep(t *testing.T) {
	f, d := open(t)
	ctx := context.Background()
	(&harness{f: f, d: d}).Given("c1")
	expires := time.Date(2026, 10, 3, 23, 59, 0, 0, time.UTC)

	for i := 0; i < 3; i++ {
		if err := d.UpdateClient(ctx, driver.UpdateClientRequest{
			RemoteID: "c1", ClaimTag: "cfg_1", UUID: "uuid-c1", DataLimitBytes: 1 << 30, ExpiresAt: expires, Enabled: true,
		}); err != nil {
			t.Fatalf("UpdateClient: %v", err)
		}
		clients, err := d.ListClients(ctx)
		if err != nil {
			t.Fatalf("ListClients: %v", err)
		}
		expires = clients[0].ExpiresAt
	}
	f.mu.Lock()
	u := *f.byName("c1")
	f.mu.Unlock()
	if u.StartDate != "2026-09-24" || u.PackageDays != 10 {
		t.Errorf("start/days = %s/%d after three round trips, want 2026-09-24/10: the expiry crept", u.StartDate, u.PackageDays)
	}

	if err := d.UpdateClient(ctx, driver.UpdateClientRequest{RemoteID: "c1", ClaimTag: "cfg_1", UUID: "uuid-c1", Enabled: true}); err != nil {
		t.Fatalf("UpdateClient: %v", err)
	}
	clients, _ := d.ListClients(ctx)
	if !clients[0].ExpiresAt.IsZero() {
		t.Errorf("no expiry reads back as %s", clients[0].ExpiresAt)
	}
}

// A regenerate is Hiddify's PATCH with a new uuid: the same row, so the name,
// the counter and the ceiling stay, and the next write finds it under the new
// uuid without another list.
func TestRegenerateKeepsTheNameAndTheCounter(t *testing.T) {
	f, d := open(t)
	ctx := context.Background()
	h := &harness{f: f, d: d}
	h.Given("c1")
	h.Serve("c1", 0, 777)
	if _, err := d.ListClients(ctx); err != nil {
		t.Fatalf("ListClients: %v", err)
	}

	if err := d.UpdateClient(ctx, driver.UpdateClientRequest{
		RemoteID: "c1", ClaimTag: "cfg_1", UUID: "11111111-2222-4333-8444-555555555555", DataLimitBytes: 2 << 30, Enabled: true,
	}); err != nil {
		t.Fatalf("UpdateClient: %v", err)
	}
	f.mu.Lock()
	u, count, lists := *f.byName("c1"), len(f.users), f.lists
	f.mu.Unlock()
	if count != 1 || u.UUID != "11111111-2222-4333-8444-555555555555" || u.Usage != 777 {
		t.Errorf("after a regenerate: %d users, uuid %s, usage %d; want one user, the new uuid, the counter kept", count, u.UUID, u.Usage)
	}
	if _, sent := f.patches[len(f.patches)-1]["current_usage_GB"]; sent {
		t.Error("an update wrote current_usage_GB: only ResetUsage may touch the counter")
	}

	if err := d.SetClientEnabled(ctx, "c1", false); err != nil {
		t.Fatalf("SetClientEnabled after the regenerate: %v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.lists != lists {
		t.Errorf("the write after a regenerate listed the panel again: the new uuid was not kept")
	}
	if f.byName("c1").Enable {
		t.Error("the client is still enabled")
	}
}

// A uuid changed on the panel by hand is a 404 on the stale one: the driver
// reads the panel once and writes to the uuid the name now carries.
func TestAUUIDChangedByHandIsFoundAgain(t *testing.T) {
	f, d := open(t)
	ctx := context.Background()
	(&harness{f: f, d: d}).Given("c1")
	if _, err := d.ListClients(ctx); err != nil {
		t.Fatalf("ListClients: %v", err)
	}
	f.mu.Lock()
	f.byName("c1").UUID = "changed-by-hand"
	f.mu.Unlock()

	if err := d.SetClientEnabled(ctx, "c1", false); err != nil {
		t.Fatalf("SetClientEnabled: %v", err)
	}
	if err := d.DeleteClient(ctx, "c1"); err != nil {
		t.Fatalf("DeleteClient: %v", err)
	}
	if err := d.DeleteClient(ctx, "c1"); err != nil {
		t.Errorf("deleting a client already gone = %v, want done", err)
	}
}

// Two users under one name cannot be told apart: neither is written to and
// neither is read for usage, so no cursor is fed two counters.
func TestANameHeldTwiceIsNeitherWrittenNorCounted(t *testing.T) {
	f, d := open(t)
	ctx := context.Background()
	h := &harness{f: f, d: d}
	h.Given("c1")
	h.Given("c2")
	f.mu.Lock()
	f.add(&farUser{UUID: "other", Name: "c1", Limit: 1 << 30, Enable: true})
	f.mu.Unlock()

	usage, err := d.GetUsage(ctx)
	if err != nil || len(usage) != 1 || usage[0].RemoteID != "c2" {
		t.Errorf("GetUsage = %+v, %v: want c2 alone", usage, err)
	}
	if err := d.SetClientEnabled(ctx, "c1", false); err == nil {
		t.Error("a write to a name two users hold succeeded")
	}
}

// Hiddify answers an empty panel with a 404, not an empty list.
func TestAnEmptyPanelIsNoUsers(t *testing.T) {
	_, d := open(t)
	usage, err := d.GetUsage(context.Background())
	if err != nil || len(usage) != 0 {
		t.Errorf("GetUsage on an empty panel = %v, %v; want none and no fault", usage, err)
	}
}

// An unknown key is Hiddify's logout redirect. Followed, it reads as a login
// page; it is a blocked fault instead, and nothing is retried.
func TestARefusedKeyIsBlocked(t *testing.T) {
	f, d := open(t)
	f.mu.Lock()
	f.key = "rotated"
	before := f.calls
	f.mu.Unlock()
	_, err := d.GetUsage(context.Background())
	if !driver.IsBlocked(err) {
		t.Fatalf("a refused key gave %v, want a blocked fault", err)
	}
	if got := f.calls - before; got != 1 {
		t.Errorf("a refused key cost %d requests, want 1", got)
	}
}

// ResetUsage is believed only when the answer reads zero.
func TestResetUsage(t *testing.T) {
	f, d := open(t)
	h := &harness{f: f, d: d}
	h.Given("c1")
	h.Serve("c1", 0, 999)
	if err := d.ResetUsage(context.Background(), "c1"); err != nil {
		t.Fatalf("ResetUsage: %v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.byName("c1").Usage != 0 {
		t.Error("the counter was not zeroed")
	}
}

// Rule 8 (F-027-bg): with the client base url, the subscription is the
// user's page under it, by the uuid the name holds now.
func TestSubscriptionIsTheUsersPageUnderTheClientPath(t *testing.T) {
	f, d := open(t)
	h := &harness{f: f, d: d}
	h.Given("c1")
	got, ok := d.SubscriptionURL(context.Background(), "c1")
	if want := d.client.String() + "/uuid-c1/"; !ok || got != want {
		t.Fatalf("SubscriptionURL = %q, %v; want %q, true", got, ok, want)
	}
	if _, ok := d.SubscriptionURL(context.Background(), "nobody"); ok {
		t.Error("a name no user holds answered a subscription")
	}
}

// Rule 8: a link is the line Hiddify itself serves for the protocol, and the
// admin key never leaves for the client path.
func TestBuildLinkReadsTheLineHiddifyServes(t *testing.T) {
	f, d := open(t)
	h := &harness{f: f, d: d}
	h.Given("c1")
	c := driver.RemoteClient{RemoteID: "c1", UUID: "uuid-c1"}
	link, err := d.BuildLink(context.Background(), c, driver.Inbound{RemoteID: "vless", Protocol: "vless"})
	if err != nil || link != "vless://uuid-c1@cdn.example.net:443?security=tls#c1" {
		t.Fatalf("BuildLink(vless) = %q, %v", link, err)
	}
	if _, err := d.BuildLink(context.Background(), c, driver.Inbound{RemoteID: "ss", Protocol: "shadowsocks"}); !driver.IsUnsupported(err) {
		t.Errorf("a protocol Hiddify serves no line for gave %v, want unsupported", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, k := range f.clientKeys {
		if k != "" {
			t.Fatal("the admin api key was sent to the client path")
		}
	}
}

// Rule 8: without a client base url there is no link and no subscription,
// and the questionnaire says so.
func TestNoClientPathNoLink(t *testing.T) {
	f := newFarEnd(t)
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	d, err := New(srv.URL+adminPath, "", apiKey, srv.Client())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	(&harness{f: f, d: d}).Given("c1")
	if _, ok := d.SubscriptionURL(context.Background(), "c1"); ok {
		t.Error("a subscription was answered with no client path")
	}
	if _, err := d.BuildLink(context.Background(), driver.RemoteClient{UUID: "uuid-c1"}, driver.Inbound{Protocol: "vless"}); !driver.IsUnsupported(err) {
		t.Errorf("BuildLink with no client path gave %v, want unsupported", err)
	}
	caps, err := d.Capabilities(context.Background())
	if err != nil || caps.Answers[driver.RowNativeSubscriptionLink].Supported {
		t.Errorf("native_subscription_link without a client path: %+v, %v", caps.Answers[driver.RowNativeSubscriptionLink], err)
	}
	_, withPath := open(t)
	caps, err = withPath.Capabilities(context.Background())
	if err != nil || !caps.Answers[driver.RowNativeSubscriptionLink].Supported {
		t.Errorf("native_subscription_link with a client path: %+v, %v", caps.Answers[driver.RowNativeSubscriptionLink], err)
	}
}

// ClientLinks is every line Hiddify serves the user at `<client
// path>/<uuid>/sub/` (contract.links.md, F-027-bi); without a client path the
// family has none to give, which is no lines and no error.
func TestClientLinksAreEveryLineHiddifyServes(t *testing.T) {
	f, d := open(t)
	(&harness{f: f, d: d}).Given("c1")
	lines, err := d.ClientLinks(context.Background(), driver.RemoteClient{RemoteID: "c1", UUID: "uuid-c1"})
	if err != nil || len(lines) != 3 || lines[1] != "vless://uuid-c1@cdn.example.net:443?security=tls#c1" {
		t.Fatalf("ClientLinks = %q, %v, want Hiddify's three lines", lines, err)
	}
	f.mu.Lock()
	for _, k := range f.clientKeys {
		if k != "" {
			t.Error("the admin api key was sent to the client path")
		}
	}
	f.mu.Unlock()
	if _, err := d.ClientLinks(context.Background(), driver.RemoteClient{RemoteID: "c9", UUID: "uuid-c9"}); err == nil {
		t.Error("a uuid the panel does not serve gave no error")
	}

	bare := newFarEnd(t)
	srv := httptest.NewServer(bare)
	t.Cleanup(srv.Close)
	noPath, err := New(srv.URL+adminPath, "", apiKey, srv.Client())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if lines, err := noPath.ClientLinks(context.Background(), driver.RemoteClient{RemoteID: "c1", UUID: "uuid-c1"}); err != nil || lines != nil {
		t.Errorf("with no client path ClientLinks = %q, %v, want none and no error", lines, err)
	}
}
