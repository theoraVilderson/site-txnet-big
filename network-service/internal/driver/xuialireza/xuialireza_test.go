package xuialireza

import (
	"context"
	"encoding/base64"
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
)

// farEnd is a scripted x-ui panel (alireza0 fork): a session cookie from a
// form login, every reply wrapped in {success, msg, obj}, an API under
// `/xui/API/inbounds`, and clients that live inside their inbound's `settings`
// JSON string while their counters live in `clientStats`. It is the far half
// of the conformance harness (F-027-bc); the driver under test is the only
// thing that talks to it.
type farEnd struct {
	t *testing.T

	mu      sync.Mutex
	clients map[string]*farClient // by email
	order   []string
	backup  map[string]farClient
	calls   int
	logins  int
	session string
	// resets counts writes that carried a `reset` key, which this fork does
	// not have: 3x-ui's auto-renewal must not be assumed here.
	resets int

	// subURI and subOff are the sub server's settings; subCookies counts
	// subscription reads that carried a cookie, which none may (F-027-bi).
	subURI     string
	subOff     bool
	subCookies int

	nextStall    time.Duration
	nextStatus   int
	ceilingDelay int
}

type farClient struct {
	Email   string
	ID      string // uuid for vless/vmess
	Pass    string // password for trojan
	Inbound int
	Enable  bool
	Total   int64
	Expiry  int64
	Comment string // not x-ui's field: kept only because the client map is stored as sent
	SubID   string
	Up      int64
	Down    int64

	pending      *int64
	pendingReads int
}

// inbounds are the far end's two listeners. Clients are scoped to one.
var inbounds = []struct {
	id       int
	protocol string
	port     int
}{{1, "vless", 443}, {2, "trojan", 8443}}

func newFarEnd(t *testing.T) *farEnd {
	return &farEnd{t: t, clients: map[string]*farClient{}, session: "s-1"}
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
		http.Error(w, "scripted", status)
		return
	}

	// The panel sits under its web base path; every route is below it.
	if subID, ok := strings.CutPrefix(r.URL.Path, "/sub/"); ok && r.Method == http.MethodGet {
		f.serveSub(w, r, subID)
		return
	}
	path, ok := strings.CutPrefix(r.URL.Path, "/base")
	if !ok {
		http.NotFound(w, r)
		return
	}

	if r.Method == http.MethodPost && path == "/login" {
		_ = r.ParseForm()
		if r.PostForm.Get("username") != "admin" || r.PostForm.Get("password") != "secret" {
			// x-ui refuses a login with a 200 and success=false.
			reply(w, false, "Invalid username or password", nil)
			return
		}
		f.mu.Lock()
		f.logins++
		session := f.session
		f.mu.Unlock()
		http.SetCookie(w, &http.Cookie{Name: "session", Value: session, Path: "/"})
		reply(w, true, "Login successfully", nil)
		return
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	// x-ui's checkLogin: the panel's own ajax gets a 200 with success=false,
	// anything else a 307 to the login page.
	if c, err := r.Cookie("session"); err != nil || c.Value != f.session {
		if r.Header.Get("X-Requested-With") == "XMLHttpRequest" {
			reply(w, false, "login again", nil)
		} else {
			http.Redirect(w, r, "/base/", http.StatusTemporaryRedirect)
		}
		return
	}

	switch {
	case r.Method == http.MethodGet && path == "/xui/API/inbounds/":
		reply(w, true, "", f.list())
	case r.Method == http.MethodPost && path == "/xui/setting/all":
		reply(w, true, "", map[string]any{
			"subEnable": !f.subOff, "subPort": 2096, "subPath": "/sub/", "subDomain": "sub.example",
			"subURI": f.subURI, "subCertFile": "/cert.pem",
		})
	case r.Method == http.MethodPost && path == "/xui/API/inbounds/addClient":
		inboundID, cl, ok := f.decode(w, r)
		if !ok {
			return
		}
		if _, taken := f.clients[cl.Email]; taken {
			reply(w, false, "Duplicate email: "+cl.Email, nil)
			return
		}
		cl.Inbound = inboundID
		f.clients[cl.Email] = cl
		f.order = append(f.order, cl.Email)
		reply(w, true, "Client(s) added Successfully", nil)
	case r.Method == http.MethodPost && strings.HasPrefix(path, "/xui/API/inbounds/updateClient/"):
		key := strings.TrimPrefix(path, "/xui/API/inbounds/updateClient/")
		_, cl, ok := f.decode(w, r)
		if !ok {
			return
		}
		old := f.byKey(key)
		if old == nil {
			reply(w, false, "Client Not Found For Update", nil)
			return
		}
		old.ID, old.Pass, old.Enable, old.Expiry, old.Comment, old.SubID =
			cl.ID, cl.Pass, cl.Enable, cl.Expiry, cl.Comment, cl.SubID
		if f.ceilingDelay > 0 {
			old.pending, old.pendingReads = &cl.Total, f.ceilingDelay
			f.ceilingDelay = 0
		} else {
			old.Total = cl.Total
		}
		reply(w, true, "Client updated Successfully", nil)
	case r.Method == http.MethodPost && strings.Contains(path, "/delClient/"):
		rest := strings.TrimPrefix(path, "/xui/API/inbounds/")
		idPart, key, _ := strings.Cut(rest, "/delClient/")
		inboundID, _ := strconv.Atoi(idPart)
		cl := f.byKey(key)
		if cl == nil || cl.Inbound != inboundID {
			reply(w, false, "Client Not Found", nil)
			return
		}
		left := 0
		for _, other := range f.clients {
			if other.Inbound == inboundID {
				left++
			}
		}
		if left == 1 {
			reply(w, false, "no client remained in Inbound", nil)
			return
		}
		delete(f.clients, cl.Email)
		for i, e := range f.order {
			if e == cl.Email {
				f.order = append(f.order[:i], f.order[i+1:]...)
				break
			}
		}
		reply(w, true, "Client deleted Successfully", nil)
	case r.Method == http.MethodPost && strings.Contains(path, "/resetClientTraffic/"):
		email := path[strings.LastIndex(path, "/")+1:]
		if cl := f.clients[email]; cl != nil {
			cl.Up, cl.Down = 0, 0
		}
		reply(w, true, "Traffic has been reset", nil)
	default:
		http.NotFound(w, r)
	}
}

// decode reads addClient / updateClient's body: the inbound id and a
// `settings` string holding exactly one client.
func (f *farEnd) decode(w http.ResponseWriter, r *http.Request) (int, *farClient, bool) {
	var body struct {
		ID       int    `json:"id"`
		Settings string `json:"settings"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		reply(w, false, "bad body", nil)
		return 0, nil, false
	}
	var settings struct {
		Clients []map[string]json.RawMessage `json:"clients"`
	}
	if err := json.Unmarshal([]byte(body.Settings), &settings); err != nil || len(settings.Clients) != 1 {
		reply(w, false, "bad settings", nil)
		return 0, nil, false
	}
	if _, ok := settings.Clients[0]["reset"]; ok {
		f.resets++
	}
	var c client
	raw, _ := json.Marshal(settings.Clients[0])
	_ = json.Unmarshal(raw, &c)
	return body.ID, &farClient{
		Email: c.Email, ID: c.ID, Pass: c.Password, Enable: c.Enable, Total: c.TotalGB,
		Expiry: c.ExpiryTime, Comment: c.Comment, SubID: c.SubID,
	}, true
}

// byKey is x-ui's client key: the uuid, or a trojan client's password.
func (f *farEnd) byKey(key string) *farClient {
	for _, c := range f.clients {
		if c.ID == key || (c.ID == "" && c.Pass == key) {
			return c
		}
	}
	return nil
}

func (f *farEnd) list() []map[string]any {
	out := []map[string]any{}
	for _, in := range inbounds {
		clients := []map[string]any{}
		stats := []map[string]any{}
		for _, email := range f.order {
			c := f.clients[email]
			if c.Inbound != in.id {
				continue
			}
			wire := map[string]any{
				"email": c.Email, "enable": c.Enable, "totalGB": c.Total, "expiryTime": c.Expiry,
				"subId": c.SubID, "limitIp": 0, "tgId": "",
			}
			if c.Comment != "" {
				wire["comment"] = c.Comment
			}
			if c.ID != "" {
				wire["id"] = c.ID
			} else {
				wire["password"] = c.Pass
			}
			clients = append(clients, wire)
			stats = append(stats, map[string]any{
				"id": len(stats) + 1, "inboundId": in.id, "enable": c.Enable, "email": c.Email,
				"up": c.Up, "down": c.Down, "expiryTime": c.Expiry, "total": c.Total,
			})
			// A delayed ceiling is taken after the read that counts it down.
			if c.pending != nil {
				if c.pendingReads--; c.pendingReads <= 0 {
					c.Total, c.pending = *c.pending, nil
				}
			}
		}
		settings, _ := json.Marshal(map[string]any{"clients": clients, "decryption": "none"})
		out = append(out, map[string]any{
			"id": in.id, "up": 0, "down": 0, "total": 0, "remark": in.protocol, "enable": true,
			"expiryTime": 0, "clientStats": stats, "listen": "", "port": in.port, "protocol": in.protocol,
			"settings": string(settings), "streamSettings": "{}", "tag": "inbound-" + strconv.Itoa(in.port),
		})
	}
	return out
}

func reply(w http.ResponseWriter, success bool, msg string, obj any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"success": success, "msg": msg, "obj": obj})
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
	h.f.clients[remoteID] = &farClient{Email: remoteID, ID: "uuid-" + remoteID, Inbound: 1, Enable: true}
	h.f.order = append(h.f.order, remoteID)
}

func (h *harness) Serve(remoteID string, up, down int64) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.clients[remoteID].Up += up
	h.f.clients[remoteID].Down += down
}

func (h *harness) ZeroCounter(remoteID string) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.clients[remoteID].Up, h.f.clients[remoteID].Down = 0, 0
}

func (h *harness) TakeBackup() {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.backup = map[string]farClient{}
	for email, c := range h.f.clients {
		h.f.backup[email] = *c
	}
}

func (h *harness) RestoreBackup() {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	for email, c := range h.f.backup {
		restored := c
		h.f.clients[email] = &restored
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
func (h *harness) AbandonSession(string) { h.f.t.Fatal("an x-ui panel has no sessions") }

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
// before any scenario counts requests.
func open(t *testing.T) (*farEnd, *Driver) {
	t.Helper()
	f := newFarEnd(t)
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	d, err := New(srv.URL+"/base/", Credentials{Username: "admin", Password: "secret"}, srv.Client())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := d.HealthCheck(context.Background()); err != nil {
		t.Fatalf("HealthCheck: %v", err)
	}
	return f, d
}

// TestConformance is the whole acceptance of the family: a pull, cumulative
// panel with a per-client ceiling. Every push and no-ceiling scenario is
// skipped by name, because x-ui cannot be put in that shape.
func TestConformance(t *testing.T) {
	conformance.Run(t, func(t *testing.T, shape conformance.Shape) (conformance.Harness, bool) {
		if shape.Transport != driver.TransportPull || shape.CounterSemantics != driver.CounterCumulative || !shape.CeilingSupported {
			return nil, false
		}
		f, d := open(t)
		return &harness{f: f, d: d}, true
	})
}

// A zero ceiling is a cut-off, and x-ui reads a totalGB of 0 as unlimited.
func TestZeroCeilingIsNeverUnlimited(t *testing.T) {
	f, d := open(t)
	(&harness{f: f, d: d}).Given("c1")

	if err := d.SetClientDataLimit(context.Background(), "c1", 0); err != nil {
		t.Fatalf("SetClientDataLimit(0): %v", err)
	}
	f.mu.Lock()
	total := f.clients["c1"].Total
	f.mu.Unlock()
	if total != 1 {
		t.Fatalf("a zero ceiling reached the panel as %d, want 1 byte: 0 is unlimited on x-ui", total)
	}
}

// A client is created under its claim tag and first block and answers every
// matching key back. The claim tag rides in a `comment` key x-ui does not
// know but stores, since it keeps the client map as sent.
func TestCreateClientRoundTrip(t *testing.T) {
	f, d := open(t)
	ctx := context.Background()
	expires := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)

	created, err := d.CreateClient(ctx, driver.CreateClientRequest{
		ClaimTag: "cfg_7f3a", UUID: "8a3c1e2b-0000-4000-8000-00000000abcd", InboundRemoteID: "1",
		Protocol: "vless", DataLimitBytes: 5 << 30, ExpiresAt: expires, Enabled: false,
	})
	if err != nil {
		t.Fatalf("CreateClient: %v", err)
	}
	if created.RemoteID != "8a3c1e2b00004000800000000000abcd" {
		t.Errorf("remote id = %q, want the uuid without hyphens as the client's email", created.RemoteID)
	}

	clients, err := d.ListClients(ctx)
	if err != nil || len(clients) != 1 {
		t.Fatalf("ListClients = %v, %v", clients, err)
	}
	c := clients[0]
	if c.Label != "cfg_7f3a" || c.UUID != "8a3c1e2b-0000-4000-8000-00000000abcd" || c.InboundRemoteID != "1" {
		t.Errorf("client = %+v: a matching key did not survive the round trip (F-027-aa)", c)
	}
	if c.Enabled {
		t.Error("a client created disabled reads as enabled")
	}
	if c.DataLimitBytes != 5<<30 || !c.ExpiresAt.Equal(expires) {
		t.Errorf("limit/expiry = %d/%s, want %d/%s", c.DataLimitBytes, c.ExpiresAt, int64(5<<30), expires)
	}

	// A regenerated uuid is sent to the key the panel knows the client by now.
	if err := d.UpdateClient(ctx, driver.UpdateClientRequest{
		RemoteID: created.RemoteID, ClaimTag: "cfg_7f3a", UUID: "11111111-2222-4333-8444-555555555555",
		DataLimitBytes: 6 << 30, ExpiresAt: expires, Enabled: true,
	}); err != nil {
		t.Fatalf("UpdateClient: %v", err)
	}
	f.mu.Lock()
	far := *f.clients[created.RemoteID]
	f.mu.Unlock()
	if far.ID != "11111111-2222-4333-8444-555555555555" || !far.Enable || far.Total != 6<<30 {
		t.Errorf("after the update the panel holds %+v", far)
	}
	if far.SubID == "" {
		t.Error("the update dropped the client's subId")
	}
	if f.resets != 0 {
		t.Errorf("%d writes carried a reset key: x-ui has no auto-renewal, and 3x-ui's is not assumed", f.resets)
	}

	url, ok := d.SubscriptionURL(ctx, created.RemoteID)
	if !ok || url != "https://sub.example:2096/sub/"+far.SubID {
		t.Errorf("SubscriptionURL = %q, %v: want the panel's sub server, path and the client's subId", url, ok)
	}
}

// x-ui answers an API request with no valid session by redirecting it to the
// login page. The driver does not follow it: it logs in again once and the
// call succeeds. A wrong password — a 200 with success=false — is blocked and
// not retried into a ban.
func TestExpiredSessionLogsInOnce(t *testing.T) {
	f, d := open(t)
	f.mu.Lock()
	f.session = "s-2"
	f.mu.Unlock()

	if _, err := d.GetUsage(context.Background()); err != nil {
		t.Fatalf("GetUsage after the session expired: %v", err)
	}
	if f.logins != 2 {
		t.Errorf("logins = %d, want 2: one at open, one after the redirect", f.logins)
	}

	d.creds.Password = "wrong"
	f.mu.Lock()
	f.session = "s-3"
	before := f.calls
	f.mu.Unlock()
	_, err := d.GetUsage(context.Background())
	if !driver.IsBlocked(err) {
		t.Fatalf("a refused login gave %v, want a blocked fault", err)
	}
	if got := f.calls - before; got != 2 {
		t.Errorf("a refused login cost %d requests, want 2 (the redirect, one login)", got)
	}
}

// x-ui refuses to delete an inbound's last client. The client is disabled
// instead, and the delete is reported as unsupported rather than as done.
func TestLastClientOfAnInboundIsDisabledNotDeleted(t *testing.T) {
	f, d := open(t)
	h := &harness{f: f, d: d}
	h.Given("c1")
	h.Given("c2")
	ctx := context.Background()

	if err := d.DeleteClient(ctx, "c1"); err != nil {
		t.Fatalf("DeleteClient(c1): %v", err)
	}
	err := d.DeleteClient(ctx, "c2")
	if !driver.IsUnsupported(err) {
		t.Fatalf("deleting the last client gave %v, want unsupported", err)
	}
	f.mu.Lock()
	c2 := f.clients["c2"]
	f.mu.Unlock()
	if c2 == nil || c2.Enable {
		t.Errorf("the last client = %+v, want it kept and disabled", c2)
	}
	if err := d.DeleteClient(ctx, "c1"); err != nil {
		t.Errorf("deleting a client already gone = %v, want done", err)
	}
}

// serveSub is the panel's subscription server: the client's links, base64 as
// the sub server answers by default, by subId and with no session.
func (f *farEnd) serveSub(w http.ResponseWriter, r *http.Request, subID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Cookie") != "" {
		f.subCookies++
	}
	for _, c := range f.clients {
		if c.SubID == subID && !f.subOff {
			body := "vless://" + c.Email + "@node.example:443#a\ntrojan://" + c.Email + "@node.example:8443#b\n"
			_, _ = w.Write([]byte(base64.StdEncoding.EncodeToString([]byte(body))))
			return
		}
	}
	http.NotFound(w, r)
}

// ClientLinks is every line the panel's sub server gives the client
// (contract.links.md, F-027-bi), read with no session; with the sub server
// off the family has none to give, which is no lines and no error.
func TestClientLinksAreTheSubServersLines(t *testing.T) {
	f, d := open(t)
	ctx := context.Background()
	created, err := d.CreateClient(ctx, driver.CreateClientRequest{
		ClaimTag: "cfg_1", UUID: "8a3c1e2b-0000-4000-8000-00000000abcd", InboundRemoteID: "1",
		Protocol: "vless", DataLimitBytes: 1 << 30, Enabled: true,
	})
	if err != nil {
		t.Fatalf("CreateClient: %v", err)
	}
	f.mu.Lock()
	f.subURI = d.base.Scheme + "://" + d.base.Host + "/sub/"
	f.mu.Unlock()
	lines, err := d.ClientLinks(ctx, created)
	want := "vless://" + created.RemoteID + "@node.example:443#a"
	if err != nil || len(lines) != 2 || lines[0] != want {
		t.Fatalf("ClientLinks = %q, %v, want the sub server's two lines, the first %q", lines, err, want)
	}
	if f.subCookies != 0 {
		t.Error("the subscription read carried the panel session")
	}

	f.mu.Lock()
	f.subOff = true
	f.mu.Unlock()
	if lines, err := d.ClientLinks(ctx, created); err != nil || lines != nil {
		t.Errorf("with the sub server off ClientLinks = %q, %v, want none and no error", lines, err)
	}
	if _, err := d.ClientLinks(ctx, driver.RemoteClient{RemoteID: "nobody"}); err == nil {
		t.Error("a client the panel does not hold gave no error")
	}
}
