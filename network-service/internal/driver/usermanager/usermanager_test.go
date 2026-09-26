package usermanager

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"network-service/internal/driver"
	"network-service/internal/driver/conformance"
)

// farEnd is a scripted RouterOS v7 REST API over User Manager: menus of rows,
// every value a string, a row addressed by `.id` or by `name`, and a GET
// filtered by any property in the query. It holds the sessions a NAS reported
// to User Manager, which is what a push family's GetUsage reads (F-027-ag).
type farEnd struct {
	t *testing.T

	mu        sync.Mutex
	tables    map[string][]map[string]string
	backup    map[string][]map[string]string
	nextID    int
	sessions  int
	abandoned map[string]bool
	calls     int
	enabled   string

	nextStall  time.Duration
	nextStatus int
}

// menus are the User Manager menus the driver may touch. Anything else is a
// 404, as on a router.
var menus = map[string]bool{
	"user": true, "limitation": true, "profile": true, "profile-limitation": true,
	"user-profile": true, "session": true, "router": true,
}

func newFarEnd(t *testing.T) *farEnd {
	return &farEnd{t: t, tables: map[string][]map[string]string{}, abandoned: map[string]bool{}, enabled: "true"}
}

func routerError(w http.ResponseWriter, status int, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": status, "message": http.StatusText(status), "detail": detail})
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
		routerError(w, status, "scripted")
		return
	}
	if user, pass, ok := r.BasicAuth(); !ok || user != "admin" || pass != "secret" {
		routerError(w, http.StatusUnauthorized, "")
		return
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, "/rest/user-manager")
	if path == "" && r.Method == http.MethodGet {
		writeJSON(w, map[string]string{"enabled": f.enabled, "use-profiles": "true"})
		return
	}
	menu, ref, _ := strings.Cut(strings.TrimPrefix(path, "/"), "/")
	if !menus[menu] {
		routerError(w, http.StatusNotFound, "no such command or directory ("+menu+")")
		return
	}

	switch {
	case ref == "" && r.Method == http.MethodGet:
		out := []map[string]string{}
		for _, row := range f.tables[menu] {
			if matches(row, r.URL.Query()) {
				out = append(out, row)
			}
		}
		writeJSON(w, out)
	case ref == "" && r.Method == http.MethodPut:
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			routerError(w, http.StatusBadRequest, "every value is a string on this API: "+err.Error())
			return
		}
		if name := body["name"]; name != "" && f.find(menu, name) != nil {
			routerError(w, http.StatusBadRequest, "failure: entry already exists")
			return
		}
		if detail := f.dangling(menu, body); detail != "" {
			routerError(w, http.StatusBadRequest, detail)
			return
		}
		f.nextID++
		body[".id"] = fmt.Sprintf("*%X", f.nextID)
		f.tables[menu] = append(f.tables[menu], body)
		writeJSON(w, body)
	case ref != "":
		row := f.find(menu, ref)
		if row == nil {
			routerError(w, http.StatusNotFound, "no such item")
			return
		}
		switch r.Method {
		case http.MethodGet:
			writeJSON(w, row)
		case http.MethodPatch:
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				routerError(w, http.StatusBadRequest, "every value is a string on this API: "+err.Error())
				return
			}
			for k, v := range body {
				row[k] = v
			}
			writeJSON(w, row)
		case http.MethodDelete:
			rows := f.tables[menu]
			for i, candidate := range rows {
				if candidate[".id"] == row[".id"] {
					f.tables[menu] = append(rows[:i:i], rows[i+1:]...)
					break
				}
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			routerError(w, http.StatusBadRequest, "no such command")
		}
	default:
		routerError(w, http.StatusBadRequest, "no such command")
	}
}

func matches(row map[string]string, query map[string][]string) bool {
	for k, vs := range query {
		if len(vs) > 0 && row[k] != vs[0] {
			return false
		}
	}
	return true
}

// find addresses a row by `.id` or by `name`, as RouterOS does.
func (f *farEnd) find(menu, ref string) map[string]string {
	for _, row := range f.tables[menu] {
		if row[".id"] == ref || (row["name"] != "" && row["name"] == ref) {
			return row
		}
	}
	return nil
}

// dangling refuses a link to a row that does not exist, as the router does.
func (f *farEnd) dangling(menu string, body map[string]string) string {
	refs := map[string]map[string]string{
		"profile-limitation": {"profile": "profile", "limitation": "limitation"},
		"user-profile":       {"user": "user", "profile": "profile"},
	}[menu]
	for field, target := range refs {
		if f.find(target, body[field]) == nil {
			return "input does not match any value of " + field
		}
	}
	return ""
}

func (f *farEnd) rows(menu string) []map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]string(nil), f.tables[menu]...)
}

func (f *farEnd) row(menu, ref string) map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.find(menu, ref)
}

func (f *farEnd) put(menu string, row map[string]string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	row[".id"] = fmt.Sprintf("*%X", f.nextID)
	f.tables[menu] = append(f.tables[menu], row)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// harness is conformance's view of the pair. Serving bytes is a NAS reporting
// a session to User Manager: the open session rises, or a new one opens.
type harness struct {
	f *farEnd
	d *Driver
}

func (h *harness) Driver() driver.Driver { return h.d }

func (h *harness) Given(remoteID string) {
	h.f.put("user", map[string]string{"name": remoteID, "password": "uuid-" + remoteID, "disabled": "false", "comment": ""})
}

func (h *harness) Serve(remoteID string, up, down int64) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	if h.f.abandoned[remoteID] {
		return
	}
	var open map[string]string
	for _, s := range h.f.tables["session"] {
		if s["user"] == remoteID && s["active"] == "true" {
			open = s
		}
	}
	if open == nil {
		h.f.sessions++
		h.f.nextID++
		open = map[string]string{
			".id": fmt.Sprintf("*%X", h.f.nextID), "user": remoteID, "active": "true",
			"acct-session-id": fmt.Sprintf("81%06d", h.f.sessions), "nas-ip-address": "10.0.0.1",
			"upload": "0", "download": "0", "status": "start",
		}
		h.f.tables["session"] = append(h.f.tables["session"], open)
	}
	add := func(field string, n int64) {
		var have int64
		fmt.Sscan(open[field], &have)
		open[field] = fmt.Sprint(have + n)
	}
	add("upload", up)
	add("download", down)
	open["status"] = "start,interim"
}

// ZeroCounter is the session ending: the next traffic opens a new one.
func (h *harness) ZeroCounter(remoteID string) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	for _, s := range h.f.tables["session"] {
		if s["user"] == remoteID && s["active"] == "true" {
			s["active"], s["status"] = "false", "start,interim,stop"
		}
	}
}

func (h *harness) TakeBackup() {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.backup = copyTables(h.f.tables)
}

func (h *harness) RestoreBackup() {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.tables = copyTables(h.f.backup)
}

func copyTables(in map[string][]map[string]string) map[string][]map[string]string {
	out := map[string][]map[string]string{}
	for menu, rows := range in {
		for _, row := range rows {
			c := map[string]string{}
			for k, v := range row {
				c[k] = v
			}
			out[menu] = append(out[menu], c)
		}
	}
	return out
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

// AbandonSession is the NAS that never sends a Stop: the session stays open at
// its last figure and nothing served afterwards reaches User Manager.
func (h *harness) AbandonSession(remoteID string) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.abandoned[remoteID] = true
}

// DelayCeilingBy is a pull scenario's, and setup refuses every pull shape.
func (h *harness) DelayCeilingBy(int) { h.f.t.Fatal("a push family is never asked for a late ceiling") }

func (h *harness) TotalCalls() int {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	return h.f.calls
}

func open(t *testing.T) (*farEnd, *Driver) {
	t.Helper()
	f := newFarEnd(t)
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	d, err := New(srv.URL, Credentials{Username: "admin", Password: "secret"}, srv.Client())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return f, d
}

// TestConformance is the acceptance of the family (F-027-j): push, session
// counters, a ceiling the router enforces, Gigawords from a RouterOS NAS. The
// pull scenarios, missing_gigawords and ceiling_refused are skipped by name.
func TestConformance(t *testing.T) {
	conformance.Run(t, func(t *testing.T, shape conformance.Shape) (conformance.Harness, bool) {
		if shape.Transport != driver.TransportPush || shape.CounterSemantics != driver.CounterSession ||
			!shape.CeilingSupported || !shape.GigawordsReported {
			return nil, false
		}
		f, d := open(t)
		return &harness{f: f, d: d}, true
	})
}

const testUUID = "8a3c1e2b-0000-4000-8000-00000000abcd"
const testName = "8a3c1e2b00004000800000000000abcd"

func create(t *testing.T, d *Driver, enabled bool) driver.RemoteClient {
	t.Helper()
	c, err := d.CreateClient(context.Background(), driver.CreateClientRequest{
		ClaimTag: "cfg_7f3a", UUID: testUUID, Protocol: "pppoe",
		DataLimitBytes: 5 << 30, RateLimitBps: 8_000_000, Enabled: enabled,
	})
	if err != nil {
		t.Fatalf("CreateClient: %v", err)
	}
	return c
}

// A client is its own chain — user, limitation, profile and the two links —
// written so that we are the only writer of the quota: no price, no validity,
// no counter reset on User Manager's schedule (internal_credit_disablable).
func TestCreateClientBuildsItsOwnChainWithNoCreditOfItsOwn(t *testing.T) {
	f, d := open(t)
	created := create(t, d, false)
	if created.RemoteID != testName {
		t.Errorf("remote id = %q, want the uuid without hyphens: it is the RADIUS User-Name the receiver places bytes by", created.RemoteID)
	}

	u := f.row("user", testName)
	if u == nil || u["password"] != testUUID || u["comment"] != "cfg_7f3a" || u["disabled"] != "true" {
		t.Fatalf("user row = %v", u)
	}
	lim := f.row("limitation", chainName(testName))
	if lim == nil || lim["transfer-limit"] != fmt.Sprint(int64(5<<30)) ||
		lim["rate-limit-rx"] != "8000000" || lim["rate-limit-tx"] != "8000000" {
		t.Fatalf("limitation row = %v", lim)
	}
	if lim["reset-counters-interval"] != "disabled" {
		t.Errorf("reset-counters-interval = %q: a counter zeroed on the router's schedule is a second writer of the quota", lim["reset-counters-interval"])
	}
	prof := f.row("profile", chainName(testName))
	if prof == nil || prof["price"] != "0" || prof["validity"] != "unlimited" || prof["starts-when"] != "assigned" {
		t.Errorf("profile row = %v: a priced or expiring profile is User Manager's own billing, and it would cut users off", prof)
	}
	if len(f.rows("profile-limitation")) != 1 || len(f.rows("user-profile")) != 1 {
		t.Errorf("links = %v / %v, want one of each", f.rows("profile-limitation"), f.rows("user-profile"))
	}

	clients, err := d.ListClients(context.Background())
	if err != nil || len(clients) != 1 {
		t.Fatalf("ListClients = %v, %v", clients, err)
	}
	c := clients[0]
	if c.Label != "cfg_7f3a" || c.UUID != testUUID || c.Enabled {
		t.Errorf("client = %+v: a matching key did not survive the round trip (F-027-aa)", c)
	}
	if c.DataLimitBytes != 5<<30 || c.RateLimitBps != 8_000_000 {
		t.Errorf("limit/rate = %d/%d, want what the router holds: %d/8000000", c.DataLimitBytes, c.RateLimitBps, int64(5<<30))
	}
}

// A create that died half way is finished by the retry, never duplicated: the
// router refuses a second row of a name, so a blind re-create would fail for
// ever and the config would never converge.
func TestAHalfMadeClientIsFinishedNotDuplicated(t *testing.T) {
	f, d := open(t)
	f.put("limitation", map[string]string{"name": chainName(testName), "transfer-limit": "1"})
	f.put("profile", map[string]string{"name": chainName(testName), "price": "0", "validity": "unlimited"})

	create(t, d, true)
	for _, menu := range []string{"user", "limitation", "profile", "profile-limitation", "user-profile"} {
		if n := len(f.rows(menu)); n != 1 {
			t.Errorf("%s rows = %d, want 1", menu, n)
		}
	}
	if got := f.row("limitation", chainName(testName))["transfer-limit"]; got != fmt.Sprint(int64(5<<30)) {
		t.Errorf("the leftover limitation kept %q: the retry must write the ceiling it was asked for", got)
	}
}

// A zero ceiling is a cut-off, and RouterOS reads a transfer-limit of 0 as no
// limit. The zero never reaches the wire (ADR-0072).
func TestZeroCeilingIsNeverUnlimited(t *testing.T) {
	f, d := open(t)
	create(t, d, true)
	if err := d.SetClientDataLimit(context.Background(), testName, 0); err != nil {
		t.Fatalf("SetClientDataLimit(0): %v", err)
	}
	if got := f.row("limitation", chainName(testName))["transfer-limit"]; got != "1" {
		t.Errorf("a zero ceiling was written as %q, want 1: 0 is unlimited on the router", got)
	}
}

// Delete takes the whole chain, and a second delete — a retry after the first
// died half way — finds nothing and succeeds.
func TestDeleteTakesTheChainAndCanBeRepeated(t *testing.T) {
	f, d := open(t)
	create(t, d, true)
	for i := 0; i < 2; i++ {
		if err := d.DeleteClient(context.Background(), testName); err != nil {
			t.Fatalf("DeleteClient #%d: %v", i+1, err)
		}
	}
	for _, menu := range []string{"user", "limitation", "profile", "profile-limitation", "user-profile"} {
		if rows := f.rows(menu); len(rows) != 0 {
			t.Errorf("%s left behind: %v", menu, rows)
		}
	}
}

// GetUsage is one request for the open sessions, split up/down as the NAS
// reported them. A closed session's last figure came in its Stop, to the
// receiver; reading it again here would offer the same bytes twice.
func TestUsageIsTheOpenSessionsInOneRequest(t *testing.T) {
	f, d := open(t)
	h := &harness{f: f, d: d}
	h.Given("c1")
	h.Given("c2")
	h.Serve("c1", 10, 20)
	h.ZeroCounter("c1")
	h.Serve("c1", 1, 2)
	h.Serve("c2", 3, 4)

	before := h.TotalCalls()
	readings, err := d.GetUsage(context.Background())
	if err != nil {
		t.Fatalf("GetUsage: %v", err)
	}
	if got := h.TotalCalls() - before; got != 1 {
		t.Errorf("GetUsage cost %d requests, want 1 (catalog 8.4)", got)
	}
	if len(readings) != 2 {
		t.Fatalf("readings = %+v, want the two open sessions", readings)
	}
	for _, r := range readings {
		if r.SessionID == "" {
			t.Errorf("reading %+v has no SessionID", r)
		}
		if r.RemoteID == "c1" && (r.UpBytes != 1 || r.DownBytes != 2) {
			t.Errorf("c1 = %d/%d, want the open session's 1/2", r.UpBytes, r.DownBytes)
		}
	}
}

// The ceiling a client is under is the most permissive of the profiles it
// holds: a second profile with no limit, attached by hand, is a money hole,
// and ListClients reports it as the no-limit finding (ADR-0072 rule 2).
func TestAHandAttachedUnlimitedProfileReadsAsNoLimit(t *testing.T) {
	f, d := open(t)
	create(t, d, true)
	f.put("limitation", map[string]string{"name": "free", "transfer-limit": "0"})
	f.put("profile", map[string]string{"name": "free"})
	f.put("profile-limitation", map[string]string{"profile": "free", "limitation": "free"})
	f.put("user-profile", map[string]string{"user": testName, "profile": "free", "state": "running-active"})

	clients, err := d.ListClients(context.Background())
	if err != nil || len(clients) != 1 {
		t.Fatalf("ListClients = %v, %v", clients, err)
	}
	if clients[0].DataLimitBytes != 0 {
		t.Errorf("ceiling = %d, want 0: the user can use the unlimited profile", clients[0].DataLimitBytes)
	}
}

// What the family cannot do is refused, never believed; a refused login is
// blocked and costs one request.
func TestWhatTheFamilyCannotDoIsRefused(t *testing.T) {
	f, d := open(t)
	ctx := context.Background()
	if _, err := d.CreateClient(ctx, driver.CreateClientRequest{UUID: testUUID, Protocol: "vless"}); !driver.IsUnsupported(err) {
		t.Errorf("CreateClient(vless) = %v, want unsupported: User Manager authenticates PPP, not Xray", err)
	}
	if err := d.ResetUsage(ctx, testName); !driver.IsUnsupported(err) {
		t.Errorf("ResetUsage = %v, want unsupported", err)
	}
	if _, err := d.BuildLink(ctx, driver.RemoteClient{RemoteID: testName}, driver.Inbound{}); !driver.IsUnsupported(err) {
		t.Errorf("BuildLink = %v, want unsupported: a PPP login is a username and a password, not a link", err)
	}
	if _, ok := d.SubscriptionURL(ctx, testName); ok {
		t.Error("SubscriptionURL answered true")
	}
	if lines, err := d.ClientLinks(ctx, driver.RemoteClient{RemoteID: testName}); err != nil || lines != nil {
		t.Errorf("ClientLinks = %q, %v, want none and no error: the family has no links to give (F-027-bi)", lines, err)
	}

	d.creds.Password = "wrong"
	before := f.calls
	if err := d.HealthCheck(ctx); !driver.IsBlocked(err) {
		t.Fatalf("a refused login gave %v, want blocked", err)
	}
	if got := f.calls - before; got != 1 {
		t.Errorf("a refused login cost %d requests, want 1", got)
	}
}

// A router with User Manager switched off answers no RADIUS at all, so the
// connection test fails rather than answering the questionnaire for it.
func TestADisabledUserManagerFailsTheConnectionTest(t *testing.T) {
	f, d := open(t)
	f.enabled = "false"
	if _, err := d.Capabilities(context.Background()); err == nil {
		t.Fatal("Capabilities succeeded on a router whose User Manager is disabled")
	}
	f.enabled = "true"
	caps, err := d.Capabilities(context.Background())
	if err != nil {
		t.Fatalf("Capabilities: %v", err)
	}
	if err := caps.Validate(driver.TransportPush); err != nil {
		t.Fatalf("the answers do not fit a push panel: %v", err)
	}
	v := caps.Verdict(driver.TransportPush, driver.CounterSession)
	if v.ReviewState != driver.ReviewAccepted || !v.MeteredSaleAllowed {
		t.Errorf("verdict = %+v, want accepted with metered sale", v)
	}
}

// An unlimited Grant's client (F-111-r) is created and rewritten with no limit,
// never under the one-byte stand-in a zero ceiling gets.
func TestAnUnlimitedClientCarriesNoLimit(t *testing.T) {
	_, d := open(t)
	conformance.NoLimitRoundTrip(t, d, driver.CreateClientRequest{
		ClaimTag: "cfg_7f3a", UUID: testUUID, Protocol: "pppoe", Enabled: true,
	}, 0)
}
