package sui

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"network-service/internal/driver"
	"network-service/internal/driver/conformance"
	"network-service/internal/source"
)

// farEnd is a scripted S-UI v1 panel under the web path `/app/`: a form login
// of `user` and `pass` answering a session cookie, a 401 for a request without
// one, every reply wrapped in {success, msg, obj}, `api/load` answering every
// inbound and client (without config or links, as v1.1 lists them; with both
// when fullList, as v1.0 did), and `api/clients?id=` one client whole.
type farEnd struct {
	t *testing.T

	mu       sync.Mutex
	password string
	session  string
	fullList bool
	clients  map[string]*farClient // by name
	order    []string
	backup   map[string]farClient
	calls    int
	writes   int
	logins   int

	nextStall  time.Duration
	nextStatus int
}

type farClient struct {
	id       int
	name     string
	uuid     string
	enable   bool
	volume   int64
	expiry   int64
	up, down int64
}

const (
	subURI     = "https://sub.example.test:2096/sub/"
	inboundTag = "vless-in"
)

func newFarEnd(t *testing.T) *farEnd {
	return &farEnd{t: t, password: "secret", clients: map[string]*farClient{}}
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
		w.WriteHeader(status)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	action := strings.TrimPrefix(r.URL.Path, "/app/api/")
	if r.Method == http.MethodPost && action == "login" {
		f.login(w, r)
		return
	}
	if r.Method != http.MethodGet {
		f.writes++
	}
	if cookie, err := r.Cookie("s-ui"); err != nil || f.session == "" || cookie.Value != f.session {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	switch {
	case r.Method == http.MethodGet && action == "load":
		reply(w, true, "", map[string]any{
			"inbounds": []map[string]any{
				{"id": 1, "type": "vless", "tag": inboundTag, "tls_id": 0, "listen": "::", "listen_port": 443},
				{"id": 2, "type": "naive", "tag": "naive-in", "tls_id": 0, "listen": "::", "listen_port": 8443},
			},
			"clients": f.list(),
			"subURI":  subURI,
		})
	case r.Method == http.MethodGet && action == "clients":
		f.one(w, r.URL.Query().Get("id"))
	default:
		reply(w, false, "unknown action", nil)
	}
}

func (f *farEnd) login(w http.ResponseWriter, r *http.Request) {
	f.logins++
	if r.FormValue("user") != "admin" || r.FormValue("pass") != f.password {
		reply(w, false, "wrong user or password", nil)
		return
	}
	f.session = "s" + strconv.Itoa(f.logins)
	http.SetCookie(w, &http.Cookie{Name: "s-ui", Value: f.session, Path: "/"})
	reply(w, true, "", nil)
}

func (f *farEnd) list() []map[string]any {
	out := make([]map[string]any, 0, len(f.order))
	for _, name := range f.order {
		c := f.clients[name]
		row := map[string]any{
			"id": c.id, "enable": c.enable, "name": c.name, "desc": "", "group": "",
			"inbounds": []int{1}, "up": c.up, "down": c.down, "volume": c.volume, "expiry": c.expiry,
		}
		if f.fullList {
			row["config"], row["links"] = c.config(), c.links()
		}
		out = append(out, row)
	}
	return out
}

func (f *farEnd) one(w http.ResponseWriter, id string) {
	for _, c := range f.clients {
		if strconv.Itoa(c.id) == id {
			reply(w, true, "", map[string]any{"clients": []map[string]any{{
				"id": c.id, "enable": c.enable, "name": c.name, "inbounds": []int{1},
				"config": c.config(), "links": c.links(),
				"up": c.up, "down": c.down, "volume": c.volume, "expiry": c.expiry,
			}}})
			return
		}
	}
	reply(w, true, "", map[string]any{"clients": []any{}})
}

func (c *farClient) config() map[string]any {
	return map[string]any{"vless": map[string]any{"name": c.name, "uuid": c.uuid, "flow": ""}}
}

func (c *farClient) links() []map[string]any {
	return []map[string]any{
		{"remark": c.name, "type": "local", "uri": "vless://" + c.uuid + "@panel.example.test:443?type=tcp#" + c.name},
		{"remark": "cdn", "type": "external", "uri": "vless://" + c.uuid + "@cdn.example.test:443?type=ws#cdn"},
	}
}

func reply(w http.ResponseWriter, success bool, msg string, obj any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"success": success, "msg": msg, "obj": obj})
}

// harness is conformance's view of the far end. Only the read-only case runs
// here: S-UI is a family an import reads, never one a panel is registered on.
type harness struct {
	f *farEnd
	d *Driver
}

func (h *harness) Driver() driver.Driver { return h.d }

func (h *harness) Given(name string) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.clients[name] = &farClient{id: len(h.f.order) + 1, name: name, uuid: "uuid-" + name, enable: true}
	h.f.order = append(h.f.order, name)
}

func (h *harness) Serve(name string, up, down int64) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.clients[name].up += up
	h.f.clients[name].down += down
}

func (h *harness) ZeroCounter(name string) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.clients[name].up, h.f.clients[name].down = 0, 0
}

func (h *harness) TakeBackup() {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.backup = map[string]farClient{}
	for name, c := range h.f.clients {
		h.f.backup[name] = *c
	}
}

func (h *harness) RestoreBackup() {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	for name, c := range h.f.backup {
		restored := c
		h.f.clients[name] = &restored
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

func (h *harness) AbandonSession(string) { h.f.t.Fatal("an S-UI panel has no sessions") }
func (h *harness) DelayCeilingBy(int)    { h.f.t.Fatal("the S-UI driver writes no ceiling") }

func (h *harness) TotalCalls() int {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	return h.f.calls
}

func (h *harness) WriteCalls() int {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	return h.f.writes
}

func open(t *testing.T) (*farEnd, *harness) {
	t.Helper()
	f := newFarEnd(t)
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	d, err := New(srv.URL+"/app", "", Credentials{Username: "admin", Password: "secret"}, srv.Client())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return f, &harness{f: f, d: d}
}

func TestConformance(t *testing.T) {
	setup := func(t *testing.T, shape conformance.Shape) (conformance.Harness, bool) {
		if shape.Transport != driver.TransportPull || shape.CounterSemantics != driver.CounterCumulative {
			return nil, false
		}
		_, h := open(t)
		return h, true
	}
	conformance.RunReadOnly(t, setup)
}

func TestSnapshotIsTheBulkReadOnly(t *testing.T) {
	f, h := open(t)
	h.Given("ali")
	h.Given("reza")
	h.Serve("ali", 1_000, 9_000)
	f.clients["ali"].volume = 50 << 30
	f.clients["ali"].expiry = 1_900_000_000
	f.clients["reza"].enable = false

	snap, err := source.Snapshot(context.Background(), h.d, source.Limits{})
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if len(snap.Inbounds) != 2 || snap.Inbounds[0] != (source.Inbound{RemoteID: "1", Tag: inboundTag, Protocol: "vless", Port: 443, Enabled: true}) {
		t.Fatalf("inbounds = %+v", snap.Inbounds)
	}
	if snap.Inbounds[1].Protocol != "naive" {
		t.Errorf("a protocol we do not sell is passed through for the dry run to skip, got %q", snap.Inbounds[1].Protocol)
	}
	ali := snap.Clients[0]
	if ali.RemoteID != "ali" || ali.Label != "ali" || ali.InboundRemoteID != "1" || ali.Protocol != "vless" || !ali.Enabled {
		t.Errorf("ali = %+v", ali)
	}
	if ali.DataLimitBytes != 50<<30 || ali.UpBytes != 1_000 || ali.DownBytes != 9_000 {
		t.Errorf("ali's limit and usage = %d, %d/%d", ali.DataLimitBytes, ali.UpBytes, ali.DownBytes)
	}
	if ali.ExpiresAt == nil || ali.ExpiresAt.Unix() != 1_900_000_000 {
		t.Errorf("ali's expiry = %v, want unix 1900000000", ali.ExpiresAt)
	}
	if ali.LinesRead {
		t.Error("v1.1 lists no links, so the snapshot cannot claim it read them")
	}
	if reza := snap.Clients[1]; reza.Enabled || reza.ExpiresAt != nil || reza.DataLimitBytes != 0 {
		t.Errorf("reza = %+v: disabled, no expiry, no limit", reza)
	}
	if f.calls > 4 {
		t.Errorf("the snapshot cost %d requests; the login and three bulk reads are the most", f.calls)
	}
}

func TestAListThatCarriesLinksIsRead(t *testing.T) {
	f, h := open(t)
	f.fullList = true
	h.Given("ali")
	clients, err := h.d.ListClients(context.Background())
	if err != nil {
		t.Fatalf("ListClients: %v", err)
	}
	if c := clients[0]; !c.LinesRead || len(c.Lines) != 2 || c.UUID != "uuid-ali" {
		t.Fatalf("a v1.0 list carries config and links: %+v", c)
	}
}

func TestLinksReadOneClientWholeAndItsSubscription(t *testing.T) {
	_, h := open(t)
	h.Given("ali")
	h.Given("reza")
	// A batch is a fresh driver in the route (one per request), so nothing
	// the snapshot read is cached.
	got, err := source.Links(context.Background(), h.d, []source.LinkRequest{{RemoteID: "reza", Label: "reza", InboundRemoteID: "1"}})
	if err != nil {
		t.Fatalf("Links: %v", err)
	}
	if got[0].SubscriptionURL != subURI+"reza" {
		t.Errorf("subscription = %q, want the panel's subURI and the name", got[0].SubscriptionURL)
	}
	if !got[0].LinesRead || len(got[0].Lines) != 2 || !strings.Contains(got[0].Lines[1], "cdn.example.test") {
		t.Errorf("lines = %+v: the panel's own, external ones included", got[0].Lines)
	}
}

func TestAClientGoneSinceTheSnapshotFailsOnItsOwn(t *testing.T) {
	_, h := open(t)
	h.Given("ali")
	got, err := source.Links(context.Background(), h.d, []source.LinkRequest{{RemoteID: "gone"}, {RemoteID: "ali"}})
	if err != nil {
		t.Fatalf("Links: %v", err)
	}
	if got[0].Failure == "" || got[1].Failure != "" || !got[1].LinesRead {
		t.Fatalf("one missing client is its own failure and the batch goes on: %+v", got)
	}
}

func TestExpiredSessionLogsInOnce(t *testing.T) {
	f, h := open(t)
	h.Given("ali")
	if _, err := h.d.ListInbounds(context.Background()); err != nil {
		t.Fatalf("ListInbounds: %v", err)
	}
	f.mu.Lock()
	f.session = "rotated-by-a-restart"
	f.mu.Unlock()
	if _, err := h.d.ListClients(context.Background()); err != nil {
		t.Fatalf("ListClients after the session expired: %v", err)
	}
	if f.logins != 2 {
		t.Errorf("logins = %d, want 2: one at first, one for the expired session", f.logins)
	}
}

func TestARefusedLoginIsBlocked(t *testing.T) {
	f, h := open(t)
	f.password = "changed"
	_, err := h.d.ListInbounds(context.Background())
	if kind, _ := driver.KindOf(err); kind != driver.FaultBlocked {
		t.Fatalf("err = %v, want blocked: credentials that never worked", err)
	}
}

func TestEveryWriteIsUnsupported(t *testing.T) {
	f, h := open(t)
	h.Given("ali")
	ctx := context.Background()
	writes := map[string]error{
		"CreateClient":       func() error { _, err := h.d.CreateClient(ctx, driver.CreateClientRequest{}); return err }(),
		"UpdateClient":       h.d.UpdateClient(ctx, driver.UpdateClientRequest{RemoteID: "ali"}),
		"SetClientEnabled":   h.d.SetClientEnabled(ctx, "ali", false),
		"DeleteClient":       h.d.DeleteClient(ctx, "ali"),
		"SetClientDataLimit": h.d.SetClientDataLimit(ctx, "ali", 1),
		"ResetUsage":         h.d.ResetUsage(ctx, "ali"),
	}
	for op, err := range writes {
		if !driver.IsUnsupported(err) {
			t.Errorf("%s: %v, want unsupported", op, err)
		}
	}
	if f.calls != 0 {
		t.Errorf("an unsupported write reached the panel %d time(s)", f.calls)
	}
}
