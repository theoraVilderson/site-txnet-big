package marzneshin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"network-service/internal/driver"
	"network-service/internal/driver/conformance"
)

// farEnd is a scripted Marzneshin: the endpoints the driver speaks, in
// Marzneshin's shapes and with the rules of its source that the driver has to
// survive — fastapi-pagination pages of at most 100, a `username` filter that
// is a substring match for one value and an exact one for two or more, a
// `data_limit` of 0 stored as unlimited, a PUT that cannot change the key, and
// a delete that frees the username. It is the far half of the conformance
// harness (F-027-ba); the driver under test is the only thing that talks to it.
type farEnd struct {
	t *testing.T

	mu      sync.Mutex
	users   map[string]*farUser
	order   []string
	backup  map[string]farUser
	calls   int
	logins  int
	token   string
	nextKey int
	// subAuth counts subscription reads that carried the admin token.
	subAuth int

	nextStall    time.Duration
	nextStatus   int
	ceilingDelay int
}

type farUser struct {
	Username  string
	Key       string
	Services  []int
	Enabled   bool
	Used      int64
	DataLimit *int64
	Strategy  string
	ExpireAt  *time.Time
	Note      string

	pending      *int64
	pendingReads int
}

var usernameRule = regexp.MustCompile(`^\w{3,32}$`)

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

	// The subscription is public, keyed by username and key.
	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/sub/") {
		f.subscription(w, r)
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/api/admins/token" {
		_ = r.ParseForm()
		if r.PostForm.Get("username") != "admin" || r.PostForm.Get("password") != "secret" {
			http.Error(w, `{"detail":"Incorrect username or password"}`, http.StatusUnauthorized)
			return
		}
		f.mu.Lock()
		f.logins++
		token := f.token
		f.mu.Unlock()
		writeJSON(w, map[string]any{"access_token": token, "is_sudo": true})
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
	case r.Method == http.MethodGet && path == "/api/admins/current":
		writeJSON(w, map[string]any{"username": "admin", "is_sudo": true})
	case r.Method == http.MethodGet && path == "/api/inbounds":
		items := []any{
			map[string]any{"id": 1, "tag": "VLESS TCP", "protocol": "vless", "config": "{}", "node": map[string]any{"id": 1}, "service_ids": []int{1, 2}},
			map[string]any{"id": 2, "tag": "Trojan WS", "protocol": "trojan", "config": "{}", "node": map[string]any{"id": 1}, "service_ids": []int{2}},
			map[string]any{"id": 3, "tag": "SS2022", "protocol": "shadowsocks2022", "config": "{}", "node": map[string]any{"id": 1}, "service_ids": []int{2}},
		}
		f.page(w, r, items)
	case r.Method == http.MethodGet && path == "/api/users":
		f.listUsers(w, r)
	case r.Method == http.MethodPost && path == "/api/users":
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"detail":"bad body"}`, http.StatusUnprocessableEntity)
			return
		}
		name, _ := body["username"].(string)
		name = strings.ToLower(name)
		if !usernameRule.MatchString(name) {
			http.Error(w, `{"detail":"username"}`, http.StatusUnprocessableEntity)
			return
		}
		if _, taken := f.users[name]; taken {
			http.Error(w, `{"detail":"User already exists"}`, http.StatusConflict)
			return
		}
		u := &farUser{Username: name, Enabled: true, Strategy: "no_reset"}
		if key, _ := body["key"].(string); key != "" {
			u.Key = key
		} else {
			f.nextKey++
			u.Key = fmt.Sprintf("%032x", f.nextKey)
		}
		if !u.apply(w, body) {
			return
		}
		f.users[name] = u
		f.order = append(f.order, name)
		writeJSON(w, u.wire())
	case strings.HasPrefix(path, "/api/users/"):
		rest := strings.TrimPrefix(path, "/api/users/")
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
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, `{"detail":"bad body"}`, http.StatusUnprocessableEntity)
				return
			}
			// UserModify inherits User: the username is a required field. Its
			// pattern is held at create only, since the suite's own names
			// (c1, …) are shorter than Marzneshin allows.
			if n, _ := body["username"].(string); n != name {
				http.Error(w, `{"detail":"username is required"}`, http.StatusUnprocessableEntity)
				return
			}
			// crud.update_user never reads the key or the username.
			delete(body, "key")
			delete(body, "username")
			if limit, ok := body["data_limit"].(float64); ok && f.ceilingDelay > 0 {
				v := int64(limit)
				if v == 0 {
					u.pending = nil
				} else {
					u.pending = &v
				}
				u.pendingReads = f.ceilingDelay
				f.ceilingDelay = 0
				delete(body, "data_limit")
			}
			if !u.apply(w, body) {
				return
			}
			writeJSON(w, u.wire())
		case r.Method == http.MethodDelete && action == "":
			// Marzneshin's delete is soft, and it frees the username.
			delete(f.users, name)
			for i, n := range f.order {
				if n == name {
					f.order = append(f.order[:i], f.order[i+1:]...)
					break
				}
			}
			writeJSON(w, map[string]any{})
		case r.Method == http.MethodPost && action == "enable":
			if u.Enabled {
				http.Error(w, `{"detail":"User is already enabled"}`, http.StatusConflict)
				return
			}
			u.Enabled = true
			writeJSON(w, u.wire())
		case r.Method == http.MethodPost && action == "disable":
			if !u.Enabled {
				http.Error(w, `{"detail":"User is not enabled"}`, http.StatusConflict)
				return
			}
			u.Enabled = false
			writeJSON(w, u.wire())
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

// listUsers is get_users: one `username` is `ilike %x%`, two or more are
// `IN`, and the answer is paged.
func (f *farEnd) listUsers(w http.ResponseWriter, r *http.Request) {
	named := r.URL.Query()["username"]
	match := func(name string) bool {
		switch len(named) {
		case 0:
			return true
		case 1:
			return strings.Contains(name, strings.ToLower(named[0]))
		}
		for _, n := range named {
			if n == name {
				return true
			}
		}
		return false
	}
	var items []any
	var read []*farUser
	for _, name := range f.order {
		if match(name) {
			items = append(items, f.users[name].wire())
			read = append(read, f.users[name])
		}
	}
	from, to, ok := f.page(w, r, items)
	if !ok {
		return
	}
	// A delayed ceiling is taken after the reads that count it down.
	for _, u := range read[from:to] {
		if u.pendingReads > 0 {
			if u.pendingReads--; u.pendingReads == 0 {
				u.DataLimit = u.pending
				u.pending = nil
			}
		}
	}
}

// page is fastapi-pagination's Page: `page` from 1, `size` 50 by default and
// 100 at most.
func (f *farEnd) page(w http.ResponseWriter, r *http.Request, items []any) (int, int, bool) {
	q := r.URL.Query()
	page, size := 1, 50
	if v := q.Get("page"); v != "" {
		page, _ = strconv.Atoi(v)
	}
	if v := q.Get("size"); v != "" {
		size, _ = strconv.Atoi(v)
	}
	if page < 1 || size < 1 || size > 100 {
		http.Error(w, `{"detail":"page >= 1, 1 <= size <= 100"}`, http.StatusUnprocessableEntity)
		return 0, 0, false
	}
	from := min((page-1)*size, len(items))
	to := min(from+size, len(items))
	out := items[from:to]
	if out == nil {
		out = []any{}
	}
	writeJSON(w, map[string]any{
		"items": out, "total": len(items), "page": page, "size": size,
		"pages": (len(items) + size - 1) / size,
	})
	return from, to, true
}

func (f *farEnd) subscription(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/sub/"), "/")
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "" {
		f.subAuth++
	}
	if len(parts) != 3 || parts[2] != "links" {
		http.NotFound(w, r)
		return
	}
	u := f.users[parts[0]]
	if u == nil || u.Key != parts[1] {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	fmt.Fprintf(w, "vless://%s@node.example:443?type=tcp#%s\n", u.Key, u.Username)
	fmt.Fprintf(w, "trojan://%s@node.example:8443?type=ws#%s\n", u.Key, u.Username)
}

// apply is crud.update_user: a field that is absent or null is left alone,
// and a data_limit of 0 is stored as no limit.
func (u *farUser) apply(w http.ResponseWriter, b map[string]any) bool {
	if v, ok := b["data_limit"].(float64); ok {
		limit := int64(v)
		if limit == 0 {
			u.DataLimit = nil
		} else {
			u.DataLimit = &limit
		}
	}
	switch b["expire_strategy"] {
	case "never":
		u.ExpireAt = nil
	case "fixed_date":
		raw, _ := b["expire_date"].(string)
		at, err := time.Parse("2006-01-02T15:04:05", raw)
		if err != nil {
			http.Error(w, `{"detail":"fixed_date without a valid expire date"}`, http.StatusUnprocessableEntity)
			return false
		}
		u.ExpireAt = &at
	case nil:
	default:
		http.Error(w, `{"detail":"expire_strategy"}`, http.StatusUnprocessableEntity)
		return false
	}
	if v, ok := b["note"].(string); ok {
		u.Note = v
	}
	if v, ok := b["data_limit_reset_strategy"].(string); ok {
		u.Strategy = v
	}
	if v, ok := b["service_ids"].([]any); ok {
		u.Services = nil
		for _, id := range v {
			u.Services = append(u.Services, int(id.(float64)))
		}
	}
	return true
}

func (u *farUser) wire() map[string]any {
	var expire any
	strategy := "never"
	if u.ExpireAt != nil {
		expire, strategy = u.ExpireAt.Format("2006-01-02T15:04:05"), "fixed_date"
	}
	services := append([]int{}, u.Services...)
	sort.Ints(services)
	return map[string]any{
		"id": 1, "username": u.Username, "key": u.Key, "enabled": u.Enabled,
		"used_traffic": u.Used, "lifetime_used_traffic": u.Used,
		"data_limit": u.DataLimit, "data_limit_reset_strategy": u.Strategy,
		"expire_strategy": strategy, "expire_date": expire, "note": u.Note,
		"service_ids": services, "subscription_url": "/sub/" + u.Username + "/" + u.Key,
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
	h.f.users[remoteID] = &farUser{Username: remoteID, Key: fmt.Sprintf("%032x", len(h.f.order)+1000),
		Services: []int{1}, Enabled: true, Strategy: "no_reset"}
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
func (h *harness) AbandonSession(string) { h.f.t.Fatal("a Marzneshin panel has no sessions") }

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
func open(t *testing.T, clientBase string) (*farEnd, *Driver, string) {
	t.Helper()
	f := newFarEnd(t)
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	d, err := New(srv.URL, clientBase, Credentials{Username: "admin", Password: "secret"}, srv.Client())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := d.HealthCheck(context.Background()); err != nil {
		t.Fatalf("HealthCheck: %v", err)
	}
	return f, d, srv.URL
}

// TestConformance is the whole acceptance of the family (F-027-j): a pull,
// cumulative panel with a per-user ceiling whose bulk read is paged (ADR-0081).
// Every push and no-ceiling scenario is skipped by name.
func TestConformance(t *testing.T) {
	conformance.Run(t, func(t *testing.T, shape conformance.Shape) (conformance.Harness, bool) {
		if shape.Transport != driver.TransportPull || shape.CounterSemantics != driver.CounterCumulative || !shape.CeilingSupported {
			return nil, false
		}
		f, d, _ := open(t, "")
		return &harness{f: f, d: d}, true
	})
}

// A zero ceiling is a cut-off (driver.SetClientDataLimit), and Marzneshin
// stores a data_limit of 0 as no limit. Written through, an exhausted
// allowance would become free traffic (ADR-0072).
func TestZeroCeilingIsNeverUnlimited(t *testing.T) {
	f, d, _ := open(t, "")
	(&harness{f: f, d: d}).Given("c1")

	if err := d.SetClientDataLimit(context.Background(), "c1", 0); err != nil {
		t.Fatalf("SetClientDataLimit(0): %v", err)
	}
	f.mu.Lock()
	limit := f.users["c1"].DataLimit
	f.mu.Unlock()
	if limit == nil || *limit != 1 {
		t.Fatalf("a zero ceiling reached the panel as %v, want 1 byte: Marzneshin serves a 0 without limit", limit)
	}
}

// A client is created under its claim tag, first block, service and expiry,
// answers every matching key back, and never under a schedule that zeroes its
// counter. Its subscription is on the client base, not the admin API.
func TestCreateClientRoundTrip(t *testing.T) {
	f, d, _ := open(t, "https://sub.example.com/")
	ctx := context.Background()
	expires := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)

	created, err := d.CreateClient(ctx, driver.CreateClientRequest{
		ClaimTag: "cfg_7f3a", UUID: "8a3c1e2b-0000-4000-8000-00000000abcd", InboundRemoteID: "2",
		Protocol: "trojan", DataLimitBytes: 5 << 30, ExpiresAt: expires, Enabled: false,
	})
	if err != nil {
		t.Fatalf("CreateClient: %v", err)
	}
	if created.RemoteID != "8a3c1e2b00004000800000000000abcd" {
		t.Errorf("remote id = %q, want the uuid without hyphens: inside Marzneshin's username rule", created.RemoteID)
	}
	f.mu.Lock()
	far := *f.users[created.RemoteID]
	f.mu.Unlock()
	if far.Key != "8a3c1e2b00004000800000000000abcd" {
		t.Errorf("key = %q, want the uuid without hyphens: the key is the client's credential", far.Key)
	}
	if far.Strategy != "no_reset" {
		t.Errorf("reset strategy = %q, want no_reset: a scheduled reset is a second writer of the quota", far.Strategy)
	}

	clients, err := d.ListClients(ctx)
	if err != nil || len(clients) != 1 {
		t.Fatalf("ListClients = %v, %v", clients, err)
	}
	c := clients[0]
	if c.Label != "cfg_7f3a" || c.UUID != "8a3c1e2b-0000-4000-8000-00000000abcd" || c.InboundRemoteID != "2" {
		t.Errorf("client = %+v: a matching key did not survive the round trip (F-027-aa)", c)
	}
	if c.Enabled {
		t.Error("a client created disabled reads as enabled")
	}
	if c.DataLimitBytes != 5<<30 || !c.ExpiresAt.Equal(expires) {
		t.Errorf("limit/expiry = %d/%s, want %d/%s", c.DataLimitBytes, c.ExpiresAt, int64(5<<30), expires)
	}

	url, ok := d.SubscriptionURL(ctx, created.RemoteID)
	want := "https://sub.example.com/sub/" + created.RemoteID + "/" + far.Key
	if !ok || url != want {
		t.Errorf("SubscriptionURL = %q, %v, want %q: a relative path is resolved against the client base (F-027-bg)", url, ok, want)
	}
}

// Marzneshin cannot change a key, so a regenerate is a delete and a create
// under the same username (user, 2026-09-24). The new client carries the whole
// desired state, and the remote id does not move.
func TestRegenerateRecreatesUnderTheSameUsername(t *testing.T) {
	f, d, _ := open(t, "")
	ctx := context.Background()
	created, err := d.CreateClient(ctx, driver.CreateClientRequest{
		ClaimTag: "cfg_1", UUID: "11111111-1111-4111-8111-111111111111", InboundRemoteID: "2",
		Protocol: "vless", DataLimitBytes: 3 << 30, Enabled: true,
	})
	if err != nil {
		t.Fatalf("CreateClient: %v", err)
	}
	(&harness{f: f, d: d}).Serve(created.RemoteID, 0, 700)

	err = d.UpdateClient(ctx, driver.UpdateClientRequest{
		RemoteID: created.RemoteID, ClaimTag: "cfg_1", UUID: "22222222-2222-4222-8222-222222222222",
		InboundRemoteID: "2", DataLimitBytes: 2 << 30, Enabled: false,
	})
	if err != nil {
		t.Fatalf("UpdateClient with a new uuid: %v", err)
	}
	clients, err := d.ListClients(ctx)
	if err != nil || len(clients) != 1 {
		t.Fatalf("ListClients = %v, %v: a regenerate leaves exactly one client", clients, err)
	}
	c := clients[0]
	if c.RemoteID != created.RemoteID || c.UUID != "22222222-2222-4222-8222-222222222222" {
		t.Errorf("client = %+v: want the same username under the new key", c)
	}
	if c.Label != "cfg_1" || c.InboundRemoteID != "2" || c.DataLimitBytes != 2<<30 || c.Enabled {
		t.Errorf("client = %+v: the recreated client lost part of its desired state", c)
	}
}

// One `username` is a substring search on Marzneshin, so c1 would find c10
// to c19 too. A hot pass over one client asks by exact name all the same.
func TestOneNamedClientIsReadExactly(t *testing.T) {
	f, d, _ := open(t, "")
	h := &harness{f: f, d: d}
	for i := 0; i < 20; i++ {
		h.Given(fmt.Sprintf("c%d", i))
	}
	before := h.TotalCalls()
	readings, err := d.GetUsageFor(context.Background(), []string{"c1"})
	if err != nil {
		t.Fatalf("GetUsageFor: %v", err)
	}
	if len(readings) != 1 || readings[0].RemoteID != "c1" {
		t.Errorf("readings = %+v, want c1 alone", readings)
	}
	if got := h.TotalCalls() - before; got != 1 {
		t.Errorf("one named client cost %d requests, want 1", got)
	}
}

// Links are Marzneshin's, read from the user's public subscription. The admin
// token never goes with that request: the subscription may be on another
// domain (F-027-bg), and the token is the panel's whole admin power.
func TestBuildLinkReadsTheSubscriptionWithoutTheToken(t *testing.T) {
	f, d, _ := open(t, "")
	ctx := context.Background()
	created, err := d.CreateClient(ctx, driver.CreateClientRequest{
		ClaimTag: "cfg_1", UUID: "11111111-1111-4111-8111-111111111111", InboundRemoteID: "2",
		Protocol: "trojan", DataLimitBytes: 1 << 30, Enabled: true,
	})
	if err != nil {
		t.Fatalf("CreateClient: %v", err)
	}
	link, err := d.BuildLink(ctx, created, driver.Inbound{RemoteID: "2", Protocol: "trojan"})
	if err != nil || !strings.HasPrefix(link, "trojan://11111111111141118111111111111111@") {
		t.Errorf("BuildLink = %q, %v, want the trojan line Marzneshin serves", link, err)
	}
	if f.subAuth != 0 {
		t.Errorf("%d subscription reads carried the admin token", f.subAuth)
	}
}

// Each service is an inbound of ours once per protocol it serves, so
// provisioning's forProtocol finds the service a config is created under. A
// protocol we do not sell is left out.
func TestInboundsAreServicesByProtocol(t *testing.T) {
	_, d, _ := open(t, "")
	got, err := d.ListInbounds(context.Background())
	if err != nil {
		t.Fatalf("ListInbounds: %v", err)
	}
	var keys []string
	for _, in := range got {
		keys = append(keys, in.RemoteID+"/"+in.Protocol)
	}
	if want := "1/vless 2/trojan 2/vless"; strings.Join(keys, " ") != want {
		t.Errorf("inbounds = %v, want %s", keys, want)
	}
}

// An expired token is the ordinary 401: one login, one retry. A wrong
// password is not retried into a ban.
func TestExpiredTokenLogsInOnce(t *testing.T) {
	f, d, _ := open(t, "")
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
		t.Errorf("a refused login cost %d requests, want 2 (the 401, one login)", got)
	}
}

// ClientLinks is the whole of the user's public subscription in `links` form
// (contract.links.md, F-027-bi), read without the admin token (rule 9).
func TestClientLinksAreTheWholeSubscription(t *testing.T) {
	f, d, _ := open(t, "")
	ctx := context.Background()
	created, err := d.CreateClient(ctx, driver.CreateClientRequest{
		ClaimTag: "cfg_1", UUID: "11111111-1111-4111-8111-111111111111", InboundRemoteID: "2",
		Protocol: "trojan", DataLimitBytes: 1 << 30, Enabled: true,
	})
	if err != nil {
		t.Fatalf("CreateClient: %v", err)
	}
	lines, err := d.ClientLinks(ctx, created)
	if err != nil || len(lines) != 2 || !strings.HasPrefix(lines[0], "vless://") || !strings.HasPrefix(lines[1], "trojan://") {
		t.Errorf("ClientLinks = %q, %v, want the vless and the trojan line Marzneshin serves", lines, err)
	}
	if f.subAuth != 0 {
		t.Errorf("%d subscription reads carried the admin token", f.subAuth)
	}
}

// An unlimited Grant's client (F-111-r) is created and rewritten with no limit,
// never under the one-byte stand-in a zero ceiling gets.
func TestAnUnlimitedClientCarriesNoLimit(t *testing.T) {
	_, d, _ := open(t, "https://sub.example.com/")
	conformance.NoLimitRoundTrip(t, d, driver.CreateClientRequest{
		ClaimTag: "cfg_7f3a", UUID: "8a3c1e2b-0000-4000-8000-00000000abcd", InboundRemoteID: "2", Protocol: "trojan", Enabled: true,
	}, 0)
}
