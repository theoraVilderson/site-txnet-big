package threexui

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"network-service/internal/driver"
	"network-service/internal/driver/conformance"
)

// farEnd is a scripted 3x-ui v3 panel (MHSanaei, v3.x): a cookie session
// opened by GET /csrf-token, a login that needs that token, every POST
// checked against it, and clients that are records of their own — keyed by
// email, attached to inbounds, with their counters beside them. It is the far
// half of the conformance harness (F-027-bb); the driver under test is the
// only thing that talks to it.
type farEnd struct {
	t *testing.T

	mu       sync.Mutex
	clients  map[string]*farClient // by email
	backup   map[string]farClient
	sessions map[string]*farSession // by cookie value
	calls    int
	logins   int
	nextSID  int

	// subURI and subOff are the sub server's settings; subCookies counts
	// subscription reads that carried a cookie, which none may (F-027-bi).
	subURI     string
	subOff     bool
	subCookies int

	nextStall    time.Duration
	nextStatus   int
	ceilingDelay int
}

type farSession struct {
	token    string
	loggedIn bool
}

type farClient struct {
	Email     string
	UUID      string // vless/vmess
	Pass      string // trojan
	Inbounds  []int
	Enable    bool
	Total     int64
	Expiry    int64
	Comment   string
	SubID     string
	LimitIP   int
	LimitHwid int
	TgID      int64
	Flow      string

	Reset, ResetDay, ResetMax int
	TrafficReset              string

	Up, Down int64

	pending      *int64
	pendingReads int
}

// inbounds are the far end's two listeners.
var inbounds = []struct {
	id       int
	protocol string
	port     int
}{{1, "vless", 443}, {2, "trojan", 8443}}

func newFarEnd(t *testing.T) *farEnd {
	return &farEnd{t: t, clients: map[string]*farClient{}, sessions: map[string]*farSession{}}
}

// expire is the panel forgetting every session: a restart, or a logout.
func (f *farEnd) expire() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sessions = map[string]*farSession{}
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

	if subID, ok := strings.CutPrefix(r.URL.Path, "/sub/"); ok && r.Method == http.MethodGet {
		f.serveSub(w, r, subID)
		return
	}
	path, ok := strings.CutPrefix(r.URL.Path, "/base")
	if !ok {
		http.NotFound(w, r)
		return
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	var sess *farSession
	if c, err := r.Cookie("3x-ui"); err == nil {
		sess = f.sessions[c.Value]
	}

	if r.Method == http.MethodGet && path == "/csrf-token" {
		if sess == nil {
			f.nextSID++
			sid := "s-" + strconv.Itoa(f.nextSID)
			sess = &farSession{token: "tok-" + sid}
			f.sessions[sid] = sess
			http.SetCookie(w, &http.Cookie{Name: "3x-ui", Value: sid, Path: "/"})
		}
		reply(w, true, "", sess.token)
		return
	}

	// v3's CSRF middleware: a POST carries the session's token, or is a 403.
	csrfOK := sess != nil && r.Header.Get("X-CSRF-Token") == sess.token

	if r.Method == http.MethodPost && path == "/login" {
		if !csrfOK {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		_ = r.ParseForm()
		if r.PostForm.Get("username") != "admin" || r.PostForm.Get("password") != "secret" {
			reply(w, false, "Wrong username or password", nil)
			return
		}
		f.logins++
		sess.loggedIn = true
		reply(w, true, "Login successfully", nil)
		return
	}

	api, ok := strings.CutPrefix(path, "/panel/api")
	if !ok {
		http.NotFound(w, r)
		return
	}
	// checkAPIAuth: no session is a 401 to the panel's own ajax, a 404 to
	// anyone else (so the API is not advertised).
	if sess == nil || !sess.loggedIn {
		if r.Header.Get("X-Requested-With") == "XMLHttpRequest" {
			w.WriteHeader(http.StatusUnauthorized)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	if r.Method == http.MethodPost && !csrfOK {
		w.WriteHeader(http.StatusForbidden)
		return
	}

	switch {
	case r.Method == http.MethodGet && api == "/clients/list":
		reply(w, true, "", f.list())
	case r.Method == http.MethodGet && api == "/inbounds/list":
		out := []map[string]any{}
		for _, in := range inbounds {
			out = append(out, map[string]any{
				"id": in.id, "enable": true, "port": in.port, "protocol": in.protocol,
				"tag": "inbound-" + strconv.Itoa(in.port), "settings": "{}", "clientStats": []any{},
			})
		}
		reply(w, true, "", out)
	case r.Method == http.MethodPost && api == "/setting/all":
		reply(w, true, "", map[string]any{
			"subEnable": !f.subOff, "subPort": 2096, "subPath": "/sub/", "subDomain": "sub.example",
			"subURI": f.subURI, "subCertFile": "/cert.pem",
		})
	case r.Method == http.MethodPost && api == "/clients/add":
		var body struct {
			Client     wireClient `json:"client"`
			InboundIds []int      `json:"inboundIds"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.InboundIds) == 0 {
			reply(w, false, "at least one inbound is required", nil)
			return
		}
		if _, taken := f.clients[body.Client.Email]; taken {
			reply(w, false, "Duplicate email: "+body.Client.Email, nil)
			return
		}
		c := &farClient{Email: body.Client.Email, Inbounds: body.InboundIds}
		f.apply(c, body.Client, 0)
		f.clients[c.Email] = c
		reply(w, true, "Client(s) added Successfully", nil)
	case r.Method == http.MethodPost && strings.HasPrefix(api, "/clients/update/"):
		c := f.clients[strings.TrimPrefix(api, "/clients/update/")]
		if c == nil {
			reply(w, false, "record not found", nil)
			return
		}
		var body struct {
			wireClient
			LimitHwid int `json:"limitHwid"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			reply(w, false, "bad body", nil)
			return
		}
		f.apply(c, body.wireClient, f.ceilingDelay)
		f.ceilingDelay = 0
		c.LimitHwid = body.LimitHwid
		reply(w, true, "Client updated Successfully", nil)
	case r.Method == http.MethodPost && strings.HasPrefix(api, "/clients/del/"):
		email := strings.TrimPrefix(api, "/clients/del/")
		if f.clients[email] == nil {
			reply(w, false, "record not found", nil)
			return
		}
		delete(f.clients, email)
		reply(w, true, "Client deleted Successfully", nil)
	case r.Method == http.MethodPost && strings.HasPrefix(api, "/clients/resetTraffic/"):
		c := f.clients[strings.TrimPrefix(api, "/clients/resetTraffic/")]
		if c == nil {
			reply(w, false, "record not found", nil)
			return
		}
		c.Up, c.Down = 0, 0
		reply(w, true, "Traffic has been reset", nil)
	default:
		http.NotFound(w, r)
	}
}

// apply is v3's Update: the whole client is written as sent, except the
// credentials and subId, which an empty value keeps. So a field the caller
// left out is a field the caller zeroed.
func (f *farEnd) apply(c *farClient, w wireClient, ceilingDelay int) {
	if w.ID != "" {
		c.UUID = w.ID
	}
	if w.Password != "" {
		c.Pass = w.Password
	}
	if w.SubID != "" {
		c.SubID = w.SubID
	}
	c.Enable, c.Expiry, c.Comment, c.LimitIP, c.TgID, c.Flow =
		w.Enable, w.ExpiryTime, w.Comment, w.LimitIP, w.TgID, w.Flow
	c.Reset, c.ResetDay, c.ResetMax, c.TrafficReset = w.Reset, w.ResetDay, w.ResetMax, w.TrafficReset
	if c.TrafficReset == "" {
		c.TrafficReset = "never"
	}
	if ceilingDelay > 0 {
		total := w.TotalGB
		c.pending, c.pendingReads = &total, ceilingDelay
	} else {
		c.Total = w.TotalGB
	}
}

// list is GET /panel/api/clients/list: every record, its inbounds and its
// counters row, in one answer.
func (f *farEnd) list() []map[string]any {
	emails := make([]string, 0, len(f.clients))
	for e := range f.clients {
		emails = append(emails, e)
	}
	sort.Strings(emails)
	out := []map[string]any{}
	for i, e := range emails {
		c := f.clients[e]
		out = append(out, map[string]any{
			"id": i + 1, "email": c.Email, "subId": c.SubID, "uuid": c.UUID, "password": c.Pass,
			"flow": c.Flow, "security": "auto", "reverse": nil, "limitIp": c.LimitIP, "limitHwid": c.LimitHwid,
			"totalGB": c.Total, "expiryTime": c.Expiry, "enable": c.Enable, "tgId": c.TgID, "group": "",
			"comment": c.Comment, "reset": c.Reset, "resetDay": c.ResetDay, "resetMax": c.ResetMax,
			"trafficReset": c.TrafficReset, "trafficResetDay": 1, "createdAt": 1, "updatedAt": 1,
			"inboundIds": c.Inbounds,
			"traffic": map[string]any{
				"id": i + 1, "inboundId": c.Inbounds[0], "enable": c.Enable, "email": c.Email,
				"up": c.Up, "down": c.Down, "expiryTime": c.Expiry, "total": c.Total,
			},
		})
		// A delayed ceiling is taken after the read that counts it down.
		if c.pending != nil {
			if c.pendingReads--; c.pendingReads <= 0 {
				c.Total, c.pending = *c.pending, nil
			}
		}
	}
	return out
}

func reply(w http.ResponseWriter, success bool, msg string, obj any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"success": success, "msg": msg, "obj": obj})
}

type harness struct {
	f *farEnd
	d *Driver
}

func (h *harness) Driver() driver.Driver { return h.d }

func (h *harness) Given(remoteID string) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.clients[remoteID] = &farClient{
		Email: remoteID, UUID: "uuid-" + remoteID, Inbounds: []int{1}, Enable: true, TrafficReset: "never",
	}
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

// AbandonSession is a push family's case; setup refuses every push shape.
func (h *harness) AbandonSession(string) { h.f.t.Fatal("a 3x-ui panel has no sessions") }

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

// TestConformance: a pull, cumulative panel with a per-client ceiling. Every
// push and no-ceiling scenario is skipped by name.
func TestConformance(t *testing.T) {
	conformance.Run(t, func(t *testing.T, shape conformance.Shape) (conformance.Harness, bool) {
		if shape.Transport != driver.TransportPull || shape.CounterSemantics != driver.CounterCumulative || !shape.CeilingSupported {
			return nil, false
		}
		f, d := open(t)
		return &harness{f: f, d: d}, true
	})
}

// v3 refuses a login, and every POST after it, that does not carry the
// session's CSRF token. The driver opens the session, reads the token, and
// sends it on each write: the create below only lands if it did.
func TestEveryWriteCarriesTheSessionsCSRFToken(t *testing.T) {
	f, d := open(t)
	if f.logins != 1 {
		t.Fatalf("logins = %d after open, want 1: the login needs the token from /csrf-token", f.logins)
	}
	if _, err := d.CreateClient(context.Background(), driver.CreateClientRequest{
		ClaimTag: "cfg_1", UUID: "8a3c1e2b-0000-4000-8000-00000000abcd", InboundRemoteID: "1",
		Protocol: "vless", DataLimitBytes: 1 << 30, Enabled: true,
	}); err != nil {
		t.Fatalf("CreateClient: %v (a 403 is a write sent without the CSRF token)", err)
	}
}

// A client is created under its claim tag and first block, answers every
// matching key back, and carries no auto-renew or reset cycle of its own.
func TestCreateClientRoundTrip(t *testing.T) {
	f, d := open(t)
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
		t.Errorf("remote id = %q, want the uuid without hyphens as the client's email", created.RemoteID)
	}

	clients, err := d.ListClients(ctx)
	if err != nil || len(clients) != 1 {
		t.Fatalf("ListClients = %v, %v", clients, err)
	}
	c := clients[0]
	if c.Label != "cfg_7f3a" || c.UUID != "8a3c1e2b-0000-4000-8000-00000000abcd" || c.InboundRemoteID != "2" {
		t.Errorf("client = %+v: a matching key did not survive the round trip (F-027-aa)", c)
	}
	if c.Enabled || c.DataLimitBytes != 5<<30 || !c.ExpiresAt.Equal(expires) {
		t.Errorf("client = %+v, want disabled, %d bytes, expiring %s", c, int64(5<<30), expires)
	}

	f.mu.Lock()
	far := *f.clients[created.RemoteID]
	f.mu.Unlock()
	if far.Pass != "8a3c1e2b-0000-4000-8000-00000000abcd" || far.UUID != "" {
		t.Errorf("a trojan client's key went to uuid=%q password=%q, want the password", far.UUID, far.Pass)
	}
	if far.SubID == "" {
		t.Error("created with no subId: the client would have no subscription")
	}

	url, ok := d.SubscriptionURL(ctx, created.RemoteID)
	if !ok || url != "https://sub.example:2096/sub/"+far.SubID {
		t.Errorf("SubscriptionURL = %q, %v: want the panel's sub server, path and the client's subId", url, ok)
	}
}

// v3 writes the whole client on update: a field left out is a field zeroed.
// So every write reads the client first and carries what we do not own, and
// holds every renewal knob off — each one is a second writer of the quota.
func TestAWriteCarriesWhatWeDoNotOwnAndNoRenewal(t *testing.T) {
	f, d := open(t)
	(&harness{f: f, d: d}).Given("c1")
	f.mu.Lock()
	c1 := f.clients["c1"]
	c1.LimitIP, c1.LimitHwid, c1.TgID, c1.Flow, c1.SubID = 3, 2, 777, "xtls-rprx-vision", "sub-c1"
	c1.Reset, c1.ResetDay, c1.ResetMax, c1.TrafficReset = 30, 5, 2, "monthly"
	f.mu.Unlock()

	if err := d.SetClientDataLimit(context.Background(), "c1", 0); err != nil {
		t.Fatalf("SetClientDataLimit(0): %v", err)
	}
	f.mu.Lock()
	got := *f.clients["c1"]
	f.mu.Unlock()
	if got.Total != 1 {
		t.Errorf("a zero ceiling reached the panel as %d, want 1 byte: 0 is unlimited on 3x-ui", got.Total)
	}
	if got.LimitIP != 3 || got.LimitHwid != 2 || got.TgID != 777 || got.Flow != "xtls-rprx-vision" || got.SubID != "sub-c1" {
		t.Errorf("after a ceiling write the panel holds %+v: a field we do not own was lost", got)
	}
	if got.UUID != "uuid-c1" || !got.Enable {
		t.Errorf("after a ceiling write uuid=%q enable=%v, want both unchanged", got.UUID, got.Enable)
	}
	if got.Reset != 0 || got.ResetDay != 0 || got.ResetMax != 0 || got.TrafficReset != "never" {
		t.Errorf("reset=%d resetDay=%d resetMax=%d trafficReset=%q: want no renewal and no reset cycle",
			got.Reset, got.ResetDay, got.ResetMax, got.TrafficReset)
	}
}

// A session the panel forgot is a 401 to the panel's own ajax: one fresh
// token, one login, one retry. A wrong password is blocked and not retried.
func TestExpiredSessionLogsInOnce(t *testing.T) {
	f, d := open(t)
	f.expire()

	if _, err := d.GetUsage(context.Background()); err != nil {
		t.Fatalf("GetUsage after the session expired: %v", err)
	}
	if f.logins != 2 {
		t.Errorf("logins = %d, want 2: one at open, one after the 401", f.logins)
	}

	d.creds.Password = "wrong"
	f.expire()
	f.mu.Lock()
	before := f.calls
	f.mu.Unlock()
	_, err := d.GetUsage(context.Background())
	if !driver.IsBlocked(err) {
		t.Fatalf("a refused login gave %v, want a blocked fault", err)
	}
	if got := f.calls - before; got != 3 {
		t.Errorf("a refused login cost %d requests, want 3 (the 401, the token, one login)", got)
	}
}

// v3 has no last-client rule: a client is a record of its own, and deleting
// it deletes it. A client already gone is done.
func TestDeleteRemovesTheLastClientToo(t *testing.T) {
	f, d := open(t)
	(&harness{f: f, d: d}).Given("c1")
	ctx := context.Background()

	if err := d.DeleteClient(ctx, "c1"); err != nil {
		t.Fatalf("DeleteClient(c1): %v", err)
	}
	f.mu.Lock()
	left := len(f.clients)
	f.mu.Unlock()
	if left != 0 {
		t.Errorf("%d clients left, want the inbound's only client deleted", left)
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
		ClaimTag: "cfg_1", UUID: "8a3c1e2b-0000-4000-8000-00000000abcd", InboundRemoteID: "2",
		Protocol: "trojan", DataLimitBytes: 1 << 30, Enabled: true,
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
