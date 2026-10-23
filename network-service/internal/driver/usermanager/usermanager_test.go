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
// filtered by any property in the query. Each user row carries its lifetime
// total, which `monitor` answers and GetUsage reads (F-027-ag-b).
type farEnd struct {
	t *testing.T

	mu      sync.Mutex
	tables  map[string][]map[string]string
	backup  map[string][]map[string]string
	nextID  int
	calls   int
	enabled string
	// useProfiles is the settings' `use-profiles`. A fresh router has it
	// off, and then User Manager ignores every profile and limitation
	// (proved on a CHR, F-1601-e).
	useProfiles string
	// writes counts requests that change the far end (RunReadOnly): every
	// PUT, PATCH and DELETE, and a POST but `monitor`, which only reads.
	writes int
	// passwordServed is whether any answer carried a user's password: an
	// import's read must never ask for one (ADR-0160 rule 2).
	passwordServed bool
	// passwordWritten is whether any write carried a user's password: an
	// adopted login's must never be touched (F-1601-b2).
	passwordWritten bool
	// clockOffset is `/system/clock`'s gmt-offset; empty is UTC.
	clockOffset string

	nextStall  time.Duration
	nextStatus int

	// ceilingDelay is how many reads of the limitations a `transfer-limit`
	// write waits before it shows (DelayCeilingBy); pending holds it by row.
	ceilingDelay int
	pending      map[string]pendingLimit
}

type pendingLimit struct {
	transfer string
	reads    int
}

// menus are the User Manager menus the driver may touch. Anything else is a
// 404, as on a router.
var menus = map[string]bool{
	"user": true, "limitation": true, "profile": true, "profile-limitation": true,
	"user-profile": true, "session": true, "router": true,
}

func newFarEnd(t *testing.T) *farEnd {
	return &farEnd{t: t, tables: map[string][]map[string]string{}, pending: map[string]pendingLimit{}, enabled: "true", useProfiles: "true"}
}

func routerError(w http.ResponseWriter, status int, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": status, "message": http.StatusText(status), "detail": detail})
}

func (f *farEnd) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.calls++
	if r.Method != http.MethodGet && !strings.HasSuffix(r.URL.Path, "/monitor") {
		f.writes++
	}
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
	if r.URL.Path == "/rest/system/clock" && r.Method == http.MethodGet {
		offset := f.clockOffset
		if offset == "" {
			offset = "+00:00"
		}
		writeJSON(w, map[string]string{"time-zone-name": "manual", "gmt-offset": offset})
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/rest/user-manager")
	if path == "" && r.Method == http.MethodGet {
		writeJSON(w, map[string]string{"enabled": f.enabled, "use-profiles": f.useProfiles})
		return
	}
	menu, ref, _ := strings.Cut(strings.TrimPrefix(path, "/"), "/")
	if !menus[menu] {
		routerError(w, http.StatusNotFound, "no such command or directory ("+menu+")")
		return
	}

	switch {
	case menu == "user" && ref == "monitor" && r.Method == http.MethodPost:
		// `/user-manager/user monitor numbers=*1,*2 once`: one answer per
		// user, in the order asked. As a v7.24 CHR answers it (F-1601-e):
		// `numbers` are row ids — a user's name is a 404 — and one unknown
		// id fails the whole command.
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["once"] != "" {
			routerError(w, http.StatusBadRequest, "monitor wants numbers and once")
			return
		}
		out := []map[string]string{}
		for _, id := range strings.Split(body["numbers"], ",") {
			u := f.byID("user", id)
			if u == nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusNotFound)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": http.StatusNotFound, "message": "Not Found"})
				return
			}
			up, down := u["total-upload"], u["total-download"]
			if up == "" {
				up = "0"
			}
			if down == "" {
				down = "0"
			}
			out = append(out, map[string]string{"total-upload": up, "total-download": down, "total-uptime": "0s"})
		}
		writeJSON(w, out)
	case ref == "" && r.Method == http.MethodGet:
		if menu == "limitation" {
			f.landLateCeilings()
		}
		out := []map[string]string{}
		for _, row := range f.tables[menu] {
			if matches(row, r.URL.Query()) {
				out = append(out, f.projected(row, r.URL.Query().Get(".proplist")))
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
		if _, ok := body["password"]; ok && menu == "user" {
			f.passwordWritten = true
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
			writeJSON(w, f.projected(row, r.URL.Query().Get(".proplist")))
		case http.MethodPatch:
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				routerError(w, http.StatusBadRequest, "every value is a string on this API: "+err.Error())
				return
			}
			if _, ok := body["password"]; ok && menu == "user" {
				f.passwordWritten = true
			}
			if transfer, ok := body["transfer-limit"]; ok && menu == "limitation" && f.ceilingDelay > 0 {
				f.pending[row[".id"]] = pendingLimit{transfer: transfer, reads: f.ceilingDelay}
				delete(body, "transfer-limit")
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

// landLateCeilings counts one read of the limitations against every delayed
// write, and shows those whose wait is over.
func (f *farEnd) landLateCeilings() {
	for id, p := range f.pending {
		if p.reads > 0 {
			p.reads--
			f.pending[id] = p
			continue
		}
		if row := f.byID("limitation", id); row != nil {
			row["transfer-limit"] = p.transfer
		}
		delete(f.pending, id)
	}
}

func matches(row map[string]string, query map[string][]string) bool {
	for k, vs := range query {
		if k == ".proplist" {
			continue // which fields come back, not which rows
		}
		if len(vs) > 0 && row[k] != vs[0] {
			return false
		}
	}
	return true
}

// projected is the row as `.proplist` asks for it: the listed fields only,
// or all of them when none is listed. It notes an answer that carries a password.
func (f *farEnd) projected(row map[string]string, proplist string) map[string]string {
	out := row
	if proplist != "" {
		out = map[string]string{}
		for _, field := range strings.Split(proplist, ",") {
			if v, ok := row[field]; ok {
				out[field] = v
			}
		}
	}
	if _, ok := out["password"]; ok {
		f.passwordServed = true
	}
	return out
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

// byID is a row by its `.id` alone: a command that takes `numbers`, as
// monitor does, reads no name.
func (f *farEnd) byID(menu, id string) map[string]string {
	for _, row := range f.tables[menu] {
		if row[".id"] == id {
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
// a session to User Manager, which adds them to the user's lifetime total.
type harness struct {
	f *farEnd
	d *Driver
}

var _ conformance.ReadCost = (*harness)(nil)

func (h *harness) Driver() driver.Driver { return h.d }

// RequestsPerRead: the users' ids, one monitor over them, the profile links.
func (h *harness) RequestsPerRead() int { return 3 }

// Given is a user as CreateClient leaves it: the user and its own chain.
func (h *harness) Given(remoteID string) {
	chain := chainName(remoteID)
	h.f.put("user", map[string]string{"name": remoteID, "password": "uuid-" + remoteID, "disabled": "false", "comment": ""})
	h.f.put("limitation", map[string]string{"name": chain, "transfer-limit": "1G", "reset-counters-interval": "disabled"})
	h.f.put("profile", map[string]string{"name": chain, "price": "0", "validity": "unlimited"})
	h.f.put("profile-limitation", map[string]string{"profile": chain, "limitation": chain})
	h.f.put("user-profile", map[string]string{"user": remoteID, "profile": chain, "state": "running-active", "end-time": "unlimited"})
}

func (h *harness) Serve(remoteID string, up, down int64) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	if u := h.f.find("user", remoteID); u != nil {
		for field, n := range map[string]int64{"total-upload": up, "total-download": down} {
			var have int64
			fmt.Sscan(u[field], &have)
			u[field] = fmt.Sprint(have + n)
		}
	}
}

// ZeroCounter is the user deleted and made again by hand under its name: its
// total starts again, the one way a lifetime total goes down.
func (h *harness) ZeroCounter(remoteID string) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	if u := h.f.find("user", remoteID); u != nil {
		u["total-upload"], u["total-download"] = "0", "0"
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

// AbandonSession and the other push scenarios are never asked: setup
// refuses every push shape.
func (h *harness) AbandonSession(string) {
	h.f.t.Fatal("a pull family is never asked to abandon a session")
}

func (h *harness) DelayCeilingBy(reads int) {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	h.f.ceilingDelay = reads
}

func (h *harness) WriteCalls() int {
	h.f.mu.Lock()
	defer h.f.mu.Unlock()
	return h.f.writes
}

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

// TestConformance is the acceptance of the family (F-027-j): pull, each
// user's lifetime total as a cumulative counter, a ceiling the router
// enforces (F-027-ag-b). The push scenarios and ceiling_refused are skipped.
func TestConformance(t *testing.T) {
	conformance.Run(t, func(t *testing.T, shape conformance.Shape) (conformance.Harness, bool) {
		if shape.Transport != driver.TransportPull || shape.CounterSemantics != driver.CounterCumulative ||
			!shape.CeilingSupported {
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

// GetUsage is each user's lifetime total, the figure User Manager keeps
// whatever its NAS sends us — which is nothing (contract.usermanager.md rule
// 11, F-027-ag-b) — with our profile link's `.id` as the origin its limit
// counts from (F-027-du-b). It is three requests whatever the number of
// users, and a user made again by hand reads from zero: the reset the
// normaliser sees.
func TestUsageIsEachUsersLifetimeTotalAndItsLink(t *testing.T) {
	f, d := open(t)
	h := &harness{f: f, d: d}
	a := create(t, d, true)
	h.Given("other")
	h.Serve(a.RemoteID, 100, 2_000)
	h.Serve("other", 5, 7)

	before := h.TotalCalls()
	readings, err := d.GetUsage(context.Background())
	if err != nil {
		t.Fatalf("GetUsage: %v", err)
	}
	if n := h.TotalCalls() - before; n != 3 {
		t.Fatalf("%d requests, want 3: the users, one monitor over all of them, the links", n)
	}
	got := map[string]driver.ClientUsage{}
	for _, r := range readings {
		if r.SessionID != "" {
			t.Errorf("reading %+v carries a session id: a lifetime total is no session's", r)
		}
		got[r.RemoteID] = r
	}
	if r := got[a.RemoteID]; r.UpBytes != 100 || r.DownBytes != 2_000 || got["other"].UpBytes+got["other"].DownBytes != 12 {
		t.Fatalf("readings = %+v", readings)
	}
	link := f.rows("user-profile")
	ours := ""
	for _, l := range link {
		if l["user"] == a.RemoteID {
			ours = l[".id"]
		}
	}
	if got[a.RemoteID].LimitOrigin != ours || ours == "" {
		t.Fatalf("origin = %q, want our link %q", got[a.RemoteID].LimitOrigin, ours)
	}
	f.put("user", map[string]string{"name": "theirs", "disabled": "false"})
	f.put("profile", map[string]string{"name": "monthly"})
	f.put("user-profile", map[string]string{"user": "theirs", "profile": "monthly", "state": "running"})

	// A link made again — removed, then the chain repaired — is a new origin.
	if err := d.remove(context.Background(), "test", "user-profile", ours); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if err := d.UpdateClient(context.Background(), driver.UpdateClientRequest{
		RemoteID: a.RemoteID, UUID: testUUID, ClaimTag: "cfg_7f3a", Enabled: true, DataLimitBytes: 5 << 30,
	}); err != nil {
		t.Fatalf("UpdateClient: %v", err)
	}
	again, err := d.GetUsage(context.Background())
	if err != nil {
		t.Fatalf("GetUsage: %v", err)
	}
	for _, r := range again {
		switch r.RemoteID {
		case a.RemoteID:
			if r.LimitOrigin == "" || r.LimitOrigin == ours {
				t.Errorf("origin after the link was made again = %q, want a new one (was %q)", r.LimitOrigin, ours)
			}
		case "theirs":
			if r.LimitOrigin != "" {
				t.Errorf("a user on its own profile reads origin %q, want none: its limit is not ours", r.LimitOrigin)
			}
		}
	}

	hot, err := d.GetUsageFor(context.Background(), []string{"other"})
	if err != nil || len(hot) != 1 || hot[0].RemoteID != "other" {
		t.Fatalf("GetUsageFor(other) = %+v, %v; want other alone", hot, err)
	}

	f.mu.Lock()
	remade := f.find("user", a.RemoteID)
	fresh := map[string]string{"name": remade["name"], "password": remade["password"], "comment": remade["comment"], "disabled": "false"}
	f.mu.Unlock()
	if err := d.DeleteClient(context.Background(), a.RemoteID); err != nil {
		t.Fatalf("DeleteClient: %v", err)
	}
	f.put("user", fresh) // an operator, by hand, under the same name
	readings, err = d.GetUsage(context.Background())
	if err != nil {
		t.Fatalf("GetUsage: %v", err)
	}
	for _, r := range readings {
		if r.RemoteID == a.RemoteID && r.UpBytes+r.DownBytes != 0 {
			t.Fatalf("a re-made user reads %d, want 0", r.UpBytes+r.DownBytes)
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
	if err := caps.Validate(driver.TransportPull); err != nil {
		t.Fatalf("the answers do not fit a pull panel: %v", err)
	}
	if err := caps.Validate(driver.TransportPush); err == nil {
		t.Fatal("the answers fit a push panel: User Manager sends us no accounting (F-027-ag-b)")
	}
	v := caps.Verdict(driver.TransportPull, driver.CounterCumulative)
	if v.ReviewState != driver.ReviewAccepted || !v.MeteredSaleAllowed {
		t.Errorf("verdict = %+v, want accepted with metered sale", v)
	}
}

// A router left at `use-profiles=no` — the default on a fresh install —
// logs a user in on name and password alone and ignores every profile and
// limitation, so no ceiling of ours would hold (proved on a CHR, F-1601-e).
// The connection test fails and names the setting.
func TestAUserManagerIgnoringProfilesFailsTheConnectionTest(t *testing.T) {
	f, d := open(t)
	f.useProfiles = "false"
	_, err := d.Capabilities(context.Background())
	if err == nil || !strings.Contains(err.Error(), "use-profiles=yes") {
		t.Fatalf("Capabilities gave %v on a router that ignores profiles, want a refusal naming use-profiles=yes", err)
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
