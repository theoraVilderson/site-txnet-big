package marzban

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

// farEnd is a scripted Marzban: the endpoints the driver speaks, in Marzban's
// shapes, holding one used_traffic figure per user — the family reports no
// up/down split, so neither does this. It is the far half of the conformance
// harness (F-027-ae); the driver under test is the only thing that talks to it.
type farEnd struct {
	t *testing.T

	mu     sync.Mutex
	users  map[string]*farUser
	order  []string
	backup map[string]farUser
	calls  int
	logins int
	token  string

	nextStall    time.Duration
	nextStatus   int
	ceilingDelay int
}

type farUser struct {
	Username  string
	UUID      string
	Protocol  string
	Inbound   string
	Status    string
	Used      int64
	DataLimit *int64
	Expire    *int64
	Note      string
	Strategy  string

	pending      *int64
	pendingReads int
}

func newFarEnd(t *testing.T) *farEnd {
	return &farEnd{t: t, users: map[string]*farUser{}, token: "tok-1"}
}

func (f *farEnd) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.calls++
	stall, status := f.nextStall, f.nextStatus
	f.nextStall, f.nextStatus = 0, 0
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
		http.Error(w, `{"detail":"scripted"}`, status)
		return
	}

	if r.Method == http.MethodPost && r.URL.Path == "/api/admin/token" {
		_ = r.ParseForm()
		if r.PostForm.Get("username") != "admin" || r.PostForm.Get("password") != "secret" {
			http.Error(w, `{"detail":"Incorrect username or password"}`, http.StatusUnauthorized)
			return
		}
		f.mu.Lock()
		f.logins++
		token := f.token
		f.mu.Unlock()
		writeJSON(w, map[string]string{"access_token": token, "token_type": "bearer"})
		return
	}
	f.mu.Lock()
	token := f.token
	f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+token {
		http.Error(w, `{"detail":"Could not validate credentials"}`, http.StatusUnauthorized)
		return
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	path := r.URL.Path
	switch {
	case r.Method == http.MethodGet && path == "/api/admin":
		writeJSON(w, map[string]any{"username": "admin", "is_sudo": true})
	case r.Method == http.MethodGet && path == "/api/inbounds":
		writeJSON(w, map[string]any{
			"vless": []map[string]any{{"tag": "VLESS TCP", "protocol": "vless", "network": "tcp", "tls": "none", "port": 443}},
		})
	case r.Method == http.MethodGet && path == "/api/users":
		named := r.URL.Query()["username"]
		want := map[string]bool{}
		for _, n := range named {
			want[n] = true
		}
		out := []map[string]any{}
		for _, name := range f.order {
			u := f.users[name]
			if len(named) == 0 || want[name] {
				out = append(out, u.wire())
			}
			// A delayed ceiling is taken after the read that counts it down.
			if u.pending != nil {
				if u.pendingReads--; u.pendingReads <= 0 {
					u.DataLimit, u.pending = u.pending, nil
				}
			}
		}
		writeJSON(w, map[string]any{"users": out, "total": len(out)})
	case r.Method == http.MethodPost && path == "/api/user":
		var body userBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"detail":"bad body"}`, http.StatusUnprocessableEntity)
			return
		}
		if body.Status != "" && body.Status != "active" && body.Status != "on_hold" {
			http.Error(w, `{"detail":"status must be active or on_hold on create"}`, http.StatusUnprocessableEntity)
			return
		}
		if _, taken := f.users[body.Username]; taken {
			http.Error(w, `{"detail":"User already exists"}`, http.StatusConflict)
			return
		}
		u := &farUser{Username: body.Username, Status: "active"}
		u.apply(body)
		f.users[u.Username] = u
		f.order = append(f.order, u.Username)
		writeJSON(w, u.wire())
	case strings.HasPrefix(path, "/api/user/"):
		rest := strings.TrimPrefix(path, "/api/user/")
		name, action, _ := strings.Cut(rest, "/")
		u := f.users[name]
		if u == nil {
			http.Error(w, `{"detail":"User not found"}`, http.StatusNotFound)
			return
		}
		switch {
		case r.Method == http.MethodGet && action == "":
			writeJSON(w, u.wire())
		case r.Method == http.MethodPut && action == "":
			var body userBody
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, `{"detail":"bad body"}`, http.StatusUnprocessableEntity)
				return
			}
			if body.DataLimit != nil && f.ceilingDelay > 0 {
				u.pending, u.pendingReads = body.DataLimit, f.ceilingDelay
				f.ceilingDelay = 0
				body.DataLimit = nil
			}
			u.apply(body)
			writeJSON(w, u.wire())
		case r.Method == http.MethodDelete && action == "":
			delete(f.users, name)
			for i, n := range f.order {
				if n == name {
					f.order = append(f.order[:i], f.order[i+1:]...)
					break
				}
			}
			writeJSON(w, map[string]string{"detail": "User successfully deleted"})
		case r.Method == http.MethodPost && action == "reset":
			u.Used = 0
			writeJSON(w, u.wire())
		default:
			http.NotFound(w, r)
		}
	default:
		http.NotFound(w, r)
	}
}

func (u *farUser) apply(b userBody) {
	for proto, p := range b.Proxies {
		u.Protocol = proto
		u.UUID = p.ID + p.Password
	}
	for _, tags := range b.Inbounds {
		if len(tags) > 0 {
			u.Inbound = tags[0]
		}
	}
	if b.DataLimit != nil {
		u.DataLimit = b.DataLimit
	}
	if b.Expire != nil {
		u.Expire = b.Expire
	}
	if b.Note != nil {
		u.Note = *b.Note
	}
	if b.Status != "" {
		u.Status = b.Status
	}
	if b.DataLimitResetStrategy != "" {
		u.Strategy = b.DataLimitResetStrategy
	}
}

func (u *farUser) wire() map[string]any {
	proxy := map[string]string{"id": u.UUID}
	if u.Protocol == "trojan" || u.Protocol == "shadowsocks" {
		proxy = map[string]string{"password": u.UUID}
	}
	proto := u.Protocol
	if proto == "" {
		proto = "vless"
	}
	return map[string]any{
		"username": u.Username, "status": u.Status, "used_traffic": u.Used,
		"data_limit": u.DataLimit, "expire": u.Expire, "note": u.Note,
		"proxies":                   map[string]any{proto: proxy},
		"inbounds":                  map[string][]string{proto: {u.Inbound}},
		"data_limit_reset_strategy": u.Strategy,
		"subscription_url":          "/sub/" + u.Username + "-token",
		"links":                     []string{proto + "://" + u.UUID + "@panel.example:443?type=tcp#" + u.Username},
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// harness is conformance's view of the pair: the driver, and the far end it
// cannot see into.
type harness struct {
	f *farEnd
	d *Driver
}

func (h *harness) Driver() driver.Driver { return h.d }

func (h *harness) Given(remoteID string) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.users[remoteID] = &farUser{Username: remoteID, UUID: "uuid-" + remoteID, Protocol: "vless", Inbound: "VLESS TCP", Status: "active"}
	h.f.order = append(h.f.order, remoteID)
}

func (h *harness) Serve(remoteID string, up, down int64) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.users[remoteID].Used += up + down
}

func (h *harness) ZeroCounter(remoteID string) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.users[remoteID].Used = 0
}

func (h *harness) TakeBackup() {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.backup = map[string]farUser{}
	for name, u := range h.f.users {
		h.f.backup[name] = *u
	}
}

func (h *harness) RestoreBackup() {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	for name, u := range h.f.backup {
		restored := u
		h.f.users[name] = &restored
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

// AbandonSession is a push family's case. Every scenario that uses it asks for
// a push shape, which setup refuses, so reaching it is the suite's bug.
func (h *harness) AbandonSession(string) { h.f.t.Fatal("a Marzban panel has no sessions") }

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

// open starts a far end and a driver logged in to it. The login is spent here,
// before any scenario counts requests, the way a long-lived driver has spent
// it long before a pass.
func open(t *testing.T) (*farEnd, *Driver) {
	t.Helper()
	f := newFarEnd(t)
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	d, err := New(srv.URL, Credentials{Username: "admin", Password: "secret"}, srv.Client())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := d.HealthCheck(context.Background()); err != nil {
		t.Fatalf("HealthCheck: %v", err)
	}
	return f, d
}

// TestConformance is the whole acceptance of the family (F-027-j): a pull,
// cumulative panel with a per-user ceiling. Every push and no-ceiling scenario
// is skipped by name, because Marzban cannot be put in that shape.
func TestConformance(t *testing.T) {
	conformance.Run(t, func(t *testing.T, shape conformance.Shape) (conformance.Harness, bool) {
		if shape.Transport != driver.TransportPull || shape.CounterSemantics != driver.CounterCumulative || !shape.CeilingSupported {
			return nil, false
		}
		f, d := open(t)
		return &harness{f: f, d: d}, true
	})
}

// A zero ceiling is a cut-off (driver.SetClientDataLimit), and Marzban reads a
// data_limit of 0 as unlimited. Writing the zero through would turn an
// exhausted allowance into free traffic (ADR-0072), so it never reaches the wire.
func TestZeroCeilingIsNeverUnlimited(t *testing.T) {
	f, d := open(t)
	(&harness{f: f, d: d}).Given("c1")

	if err := d.SetClientDataLimit(context.Background(), "c1", 0); err != nil {
		t.Fatalf("SetClientDataLimit(0): %v", err)
	}
	f.mu.Lock()
	limit := f.users["c1"].DataLimit
	f.mu.Unlock()
	if limit == nil || *limit <= 0 {
		t.Fatalf("a zero ceiling reached the panel as %v: Marzban serves that user without limit", limit)
	}
	if *limit != 1 {
		t.Errorf("a zero ceiling was written as %d, want 1 byte: the smallest figure Marzban enforces", *limit)
	}
}

// A client is created under its claim tag and first block, answers every
// matching key back, and never under a schedule that zeroes its counter.
func TestCreateClientRoundTrip(t *testing.T) {
	f, d := open(t)
	ctx := context.Background()
	expires := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)

	created, err := d.CreateClient(ctx, driver.CreateClientRequest{
		ClaimTag: "cfg_7f3a", UUID: "8a3c1e2b-0000-4000-8000-00000000abcd", InboundRemoteID: "VLESS TCP",
		Protocol: "vless", DataLimitBytes: 5 << 30, ExpiresAt: expires, Enabled: false,
	})
	if err != nil {
		t.Fatalf("CreateClient: %v", err)
	}
	if created.RemoteID != "8a3c1e2b00004000800000000000abcd" {
		t.Errorf("remote id = %q, want the uuid without hyphens: 32 characters, inside Marzban's username rule", created.RemoteID)
	}

	clients, err := d.ListClients(ctx)
	if err != nil || len(clients) != 1 {
		t.Fatalf("ListClients = %v, %v", clients, err)
	}
	c := clients[0]
	if c.Label != "cfg_7f3a" || c.UUID != "8a3c1e2b-0000-4000-8000-00000000abcd" || c.InboundRemoteID != "VLESS TCP" {
		t.Errorf("client = %+v: a matching key did not survive the round trip (F-027-aa)", c)
	}
	if c.Enabled {
		t.Error("a client created disabled reads as enabled")
	}
	if c.DataLimitBytes != 5<<30 || !c.ExpiresAt.Equal(expires) {
		t.Errorf("limit/expiry = %d/%s, want %d/%s", c.DataLimitBytes, c.ExpiresAt, int64(5<<30), expires)
	}
	f.mu.Lock()
	strategy := f.users[created.RemoteID].Strategy
	f.mu.Unlock()
	if strategy != "no_reset" {
		t.Errorf("reset strategy = %q, want no_reset: a panel that zeroes the counter on a schedule is a second writer of the quota", strategy)
	}

	url, ok := d.SubscriptionURL(ctx, created.RemoteID)
	if !ok || !strings.HasPrefix(url, "http") || !strings.HasSuffix(url, "/sub/"+created.RemoteID+"-token") {
		t.Errorf("SubscriptionURL = %q, %v: a relative path is resolved against the panel", url, ok)
	}
}

// An expired token is Marzban's ordinary 401: the driver logs in again once
// and the call succeeds. A wrong password is not retried into a ban.
func TestExpiredTokenLogsInOnce(t *testing.T) {
	f, d := open(t)
	f.mu.Lock()
	f.token = "tok-2"
	f.mu.Unlock()

	if _, err := d.GetUsage(context.Background()); err != nil {
		t.Fatalf("GetUsage after the token expired: %v", err)
	}
	if f.logins != 2 {
		t.Errorf("logins = %d, want 2: one at open, one after the 401", f.logins)
	}

	d.creds.Password = "wrong"
	f.mu.Lock()
	f.token = "tok-3"
	before := f.calls
	f.mu.Unlock()
	_, err := d.GetUsage(context.Background())
	if !driver.IsBlocked(err) {
		t.Fatalf("a refused login gave %v, want a blocked fault", err)
	}
	if got := f.calls - before; got != 2 {
		t.Errorf("a refused login cost %d requests, want 2 (the 401, one login): retrying it is how an address gets banned", got)
	}
}

// ClientLinks is every line Marzban built for the user (contract.links.md,
// F-027-bi): the `links` Marzban serves, not a line assembled here.
func TestClientLinksAreTheLinesMarzbanBuilt(t *testing.T) {
	_, d := open(t)
	ctx := context.Background()
	created, err := d.CreateClient(ctx, driver.CreateClientRequest{
		ClaimTag: "cfg_1", UUID: "11111111-1111-4111-8111-111111111111", InboundRemoteID: "VLESS TCP",
		Protocol: "vless", DataLimitBytes: 1 << 30, Enabled: true,
	})
	if err != nil {
		t.Fatalf("CreateClient: %v", err)
	}
	lines, err := d.ClientLinks(ctx, created)
	want := "vless://11111111-1111-4111-8111-111111111111@panel.example:443?type=tcp#" + created.RemoteID
	if err != nil || len(lines) != 1 || lines[0] != want {
		t.Errorf("ClientLinks = %q, %v, want [%q]", lines, err, want)
	}
	if _, err := d.ClientLinks(ctx, driver.RemoteClient{RemoteID: "nobody"}); err == nil {
		t.Error("a user the panel does not hold gave no error: a failed read is not a user with no links")
	}
}
