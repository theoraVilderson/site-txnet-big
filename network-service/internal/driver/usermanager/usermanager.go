// Package usermanager is the driver for Mikrotik User Manager on RouterOS v7
// (F-027-ag): the first push family. The NAS pushes RADIUS accounting to our
// receiver (`internal/radius`), and this driver is the other half — the
// router's REST API, through which a client is made, capped and removed.
//
// User Manager has no per-user byte ceiling of its own: a ceiling is a
// limitation, attached to a profile, attached to the user. So every client is
// its own chain of five rows — user, limitation, profile, and the two links
// between them — and the limitation and profile are named after the user
// (chainName), so the chain is found without keeping any id of the router's.
//
// Two of the family's defaults would make it a second writer of the quota, and
// the driver holds both at the wire so nothing above it has to know:
//
//   - a profile with a price or a validity is User Manager's own billing: it
//     waits for a payment, or ends the user on its own clock. Every profile we
//     write is `price=0`, `validity=unlimited`, `starts-when=assigned`.
//   - a limitation with a `reset-counters-interval` zeroes the user's usage on
//     the router's schedule. Every limitation write sets it `disabled`.
//
// RouterOS reads a `transfer-limit` of 0 as no limit, and a ceiling of zero is
// a cut-off here (driver.Driver.SetClientDataLimit), so zero is written as one
// byte — as on Marzban.
package usermanager

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"network-service/internal/driver"
)

// Credentials is a RouterOS login with the `rest-api` policy. It is sent on
// every request: the REST API has no session.
type Credentials struct {
	Username string
	Password string
}

// Driver is one router's User Manager. It holds no state between calls, so it
// is safe for concurrent use; driver.Pace is what keeps that use from becoming
// a flood.
type Driver struct {
	base  *url.URL
	creds Credentials
	http  *http.Client
}

var _ driver.Driver = (*Driver)(nil)

// protocols are the services a User Manager login is used for. It
// authenticates PPP and OpenVPN sessions on the NAS; an Xray client is not a
// thing it can hold.
var protocols = []string{"pppoe", "openvpn"}

// chainPrefix names the limitation and profile that belong to one user.
const chainPrefix = "txnet-"

func chainName(user string) string { return chainPrefix + user }

// New builds a driver over the router at baseURL (scheme and host; the
// `/rest` path is the driver's). Nothing is sent until the first call.
func New(baseURL string, creds Credentials, client *http.Client) (*Driver, error) {
	base, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("usermanager: base url %q is not an absolute url", baseURL)
	}
	if client == nil {
		// No client timeout: the caller's context is the deadline (driver.Driver).
		client = &http.Client{}
	}
	return &Driver{base: base, creds: creds, http: client}, nil
}

// ---- wire ------------------------------------------------------------------

// row is one RouterOS row. Every value on this API is a string, both ways.
type row map[string]string

func limitationBody(transfer string, rateBps int64) row {
	body := rateBody(rateBps)
	body["transfer-limit"] = transfer
	body["reset-counters-interval"] = "disabled"
	return body
}

// transferLimit is a `transfer-limit` as the router must be told it: 0, its no
// limit, only for a client wanted with none (F-111-r); a ceiling is never
// below one byte (package doc).
func transferLimit(none bool, ceilingBytes int64) string {
	if none {
		return "0"
	}
	return strconv.FormatInt(max(ceilingBytes, 1), 10)
}

// createdLimit is what a create answers for the limit it wrote: none reads as
// 0, as ListClients reads it.
func createdLimit(req driver.CreateClientRequest) int64 {
	if req.NoDataLimit {
		return 0
	}
	return max(req.DataLimitBytes, 1)
}

// rateBody writes one rate both ways. 0 is no cap, on the router as here.
func rateBody(rateBps int64) row {
	if rateBps < 0 {
		rateBps = 0
	}
	rate := strconv.FormatInt(rateBps, 10)
	return row{"rate-limit-rx": rate, "rate-limit-tx": rate}
}

func profileBody() row {
	return row{"price": "0", "validity": "unlimited", "starts-when": "assigned"}
}

func userBody(password, claimTag string, enabled bool) row {
	return row{"password": password, "comment": claimTag, "disabled": disabled(enabled)}
}

func disabled(enabled bool) string {
	if enabled {
		return "false"
	}
	return "true"
}

// quantity reads a RouterOS number: plain, or with a k/M/G/T suffix. Byte
// sizes are binary on RouterOS and rates decimal, so the caller names the base.
func quantity(s string, base int64) (int64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, nil
	}
	mult := int64(1)
	switch s[len(s)-1] {
	case 'k', 'K':
		mult = base
	case 'M':
		mult = base * base
	case 'G':
		mult = base * base * base
	case 'T':
		mult = base * base * base * base
	}
	if mult != 1 {
		s = s[:len(s)-1]
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, err
	}
	return n * mult, nil
}

// ---- transport -------------------------------------------------------------

func (d *Driver) call(ctx context.Context, op, method string, path []string, query url.Values, body row, out any) error {
	u := d.base.JoinPath(append([]string{"rest", "user-manager"}, path...)...)
	u.RawQuery = query.Encode()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return driver.NewFault(driver.FaultProtocol, op, 0, err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	// A refused login is a 401, classified blocked, and not retried: there is
	// no token to refresh, so a retry is the same wrong password again.
	req.SetBasicAuth(d.creds.Username, d.creds.Password)

	resp, err := d.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return driver.NewFault(driver.FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, err))
		}
		return driver.NewFault(driver.FaultUnavailable, op, 0, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		var answer struct {
			Detail  string `json:"detail"`
			Message string `json:"message"`
		}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 512)).Decode(&answer)
		fault := driver.FaultForStatus(op, resp.StatusCode, fmt.Errorf("%s", strings.TrimSpace(answer.Message+": "+answer.Detail)))
		if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && seconds > 0 {
			fault.RetryAfter = time.Duration(seconds) * time.Second
		}
		return fault
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return driver.NewFault(driver.FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, err))
		}
		return driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("decoding the answer: %w", err))
	}
	return nil
}

func isNotFound(err error) bool {
	var fault *driver.Fault
	return errors.As(err, &fault) && fault.Status == http.StatusNotFound
}

func (d *Driver) list(ctx context.Context, op, menu string, filter url.Values) ([]row, error) {
	var rows []row
	err := d.call(ctx, op, http.MethodGet, []string{menu}, filter, nil, &rows)
	return rows, err
}

func (d *Driver) patch(ctx context.Context, op, menu, ref string, body row) error {
	return d.call(ctx, op, http.MethodPatch, []string{menu, ref}, nil, body, nil)
}

// remove deletes one row. A row already gone is the outcome asked for, so a
// delete that died half way is finished by its retry.
func (d *Driver) remove(ctx context.Context, op, menu, ref string) error {
	err := d.call(ctx, op, http.MethodDelete, []string{menu, ref}, nil, nil, nil)
	if isNotFound(err) {
		return nil
	}
	return err
}

// ensureNamed writes a named row as it should now be: patched if the router
// has it, created if not. The router refuses a second row of a name, so a
// create that died half way would otherwise fail on every retry.
func (d *Driver) ensureNamed(ctx context.Context, op, menu, name string, body row) error {
	rows, err := d.list(ctx, op, menu, url.Values{"name": {name}})
	if err != nil {
		return err
	}
	if len(rows) > 0 {
		return d.patch(ctx, op, menu, rows[0][".id"], body)
	}
	created := row{"name": name}
	for k, v := range body {
		created[k] = v
	}
	return d.call(ctx, op, http.MethodPut, []string{menu}, nil, created, nil)
}

// ensureLink makes a link row unless one with these fields exists.
func (d *Driver) ensureLink(ctx context.Context, op, menu string, fields row) error {
	filter := url.Values{}
	for k, v := range fields {
		filter.Set(k, v)
	}
	rows, err := d.list(ctx, op, menu, filter)
	if err != nil || len(rows) > 0 {
		return err
	}
	return d.call(ctx, op, http.MethodPut, []string{menu}, nil, fields, nil)
}

// ensureChain writes the limitation, the profile and the link between them,
// then the user's link to the profile when the user exists. The order is the
// safe one: until the last link a user has no profile, and User Manager
// refuses a login with none, so a half-made client carries no traffic.
func (d *Driver) ensureChain(ctx context.Context, op, user, transfer string, rateBps int64, withUser func() error) error {
	chain := chainName(user)
	if err := d.ensureNamed(ctx, op, "limitation", chain, limitationBody(transfer, rateBps)); err != nil {
		return err
	}
	if err := d.ensureNamed(ctx, op, "profile", chain, profileBody()); err != nil {
		return err
	}
	if err := d.ensureLink(ctx, op, "profile-limitation", row{"profile": chain, "limitation": chain}); err != nil {
		return err
	}
	if err := withUser(); err != nil {
		return err
	}
	return d.ensureLink(ctx, op, "user-profile", row{"user": user, "profile": chain})
}

// ---- the driver ------------------------------------------------------------

// Capabilities proves the login and that User Manager is running, then answers
// for the family. A router whose User Manager is off answers no RADIUS, so it
// fails the test rather than being answered for.
func (d *Driver) Capabilities(ctx context.Context) (driver.Capabilities, error) {
	var settings row
	if err := d.call(ctx, "Capabilities", http.MethodGet, nil, nil, nil, &settings); err != nil {
		return driver.Capabilities{}, err
	}
	if settings["enabled"] != "true" {
		return driver.Capabilities{}, driver.NewFault(driver.FaultProtocol, "Capabilities", 0,
			errors.New("user manager is disabled on this router: /user-manager set enabled=yes"))
	}
	yes := func(detail string) driver.Answer { return driver.Answer{Supported: true, Detail: detail} }
	no := func(detail string) driver.Answer { return driver.Answer{Supported: false, Detail: detail} }
	return driver.Capabilities{
		Version:    driver.CapabilitiesVersion,
		AnsweredAt: time.Now().UTC(),
		Answers: map[driver.RowKey]driver.Answer{
			driver.RowPerClientUsage:          yes("upload and download per session, per user"),
			driver.RowUsageResetSupported:     no("no reset is used; a session's counters end with the session"),
			driver.RowCounterSurvivesUpdate:   yes("a session's counters belong to the session; editing the user or its limitation leaves them"),
			driver.RowGigawordsReported:       yes("a RouterOS NAS sends Acct-*-Gigawords; the receiver still holds any session that arrives without them"),
			driver.RowPerClientDataLimit:      yes("transfer-limit on the user's own limitation, enforced by User Manager; zero is written as one byte, since 0 is no limit there"),
			driver.RowDataLimitCountsSameByte: yes("transfer-limit is checked against upload plus download, the octets the NAS reports to us"),
			driver.RowPerClientRateLimit:      yes("rate-limit-rx and rate-limit-tx on the user's own limitation"),
			driver.RowPerClientIPLimit:        no("shared-users on the user would hold it; this driver does not write it yet"),
			driver.RowEnableDisableClient:     yes("disabled=yes refuses the next login; an open session is not cut"),
			driver.RowClientLifecycle:         yes("PUT, PATCH and DELETE on /user-manager/user and its chain"),
			driver.RowStableRemoteID:          no("the remote id is the user's name, the User-Name accounting carries; a name edited on the router reads as missing until the claim tag matches"),
			driver.RowClientLabelStorable:     yes("the comment field"),
			driver.RowNativeSubscriptionLink:  no("a PPP login is a username and a password, not a link"),
			driver.RowServerSideExpiry:        no("a profile's validity counts from assignment, not to a date; expiry stays ours"),
			driver.RowInternalCreditDisabled:  yes("every profile we write is price=0, validity=unlimited, and its limitation never resets counters"),
		},
	}, nil
}

// HealthCheck reads User Manager's settings: one row, the cheapest call that
// needs the login.
func (d *Driver) HealthCheck(ctx context.Context) error {
	return d.call(ctx, "HealthCheck", http.MethodGet, nil, nil, nil, nil)
}

// ListInbounds lists the NASes User Manager answers. A NAS is where a login
// is used, which is the nearest thing this family has to an inbound; it serves
// several protocols, so Protocol is left empty rather than guessed.
func (d *Driver) ListInbounds(ctx context.Context) ([]driver.Inbound, error) {
	routers, err := d.list(ctx, "ListInbounds", "router", nil)
	if err != nil {
		return nil, err
	}
	out := make([]driver.Inbound, 0, len(routers))
	for _, r := range routers {
		out = append(out, driver.Inbound{RemoteID: r["name"], Tag: r["name"], Host: r["address"], Enabled: r["disabled"] != "true"})
	}
	return out, nil
}

// ListClients reads every user with the ceiling and rate it is actually
// under: four requests, whatever the number of users. A user's ceiling is the
// most permissive of the profiles it holds, because that is what it can use —
// a second, unlimited profile attached by hand reads as no limit, which is the
// money-hole finding (ADR-0072 rule 2), not ours hidden behind it.
func (d *Driver) ListClients(ctx context.Context) ([]driver.RemoteClient, error) {
	const op = "ListClients"
	users, err := d.list(ctx, op, "user", nil)
	if err != nil {
		return nil, err
	}
	userProfiles, err := d.list(ctx, op, "user-profile", nil)
	if err != nil {
		return nil, err
	}
	profileLimitations, err := d.list(ctx, op, "profile-limitation", nil)
	if err != nil {
		return nil, err
	}
	limitations, err := d.list(ctx, op, "limitation", nil)
	if err != nil {
		return nil, err
	}

	byName := map[string]row{}
	for _, l := range limitations {
		byName[l["name"]] = l
	}
	limitsOf := map[string][]row{}
	for _, pl := range profileLimitations {
		if l, ok := byName[pl["limitation"]]; ok {
			limitsOf[pl["profile"]] = append(limitsOf[pl["profile"]], l)
		}
	}
	held := map[string][]row{}
	for _, up := range userProfiles {
		if up["state"] != "used" { // a used profile has ended and grants nothing
			held[up["user"]] = append(held[up["user"]], limitsOf[up["profile"]]...)
		}
	}

	out := make([]driver.RemoteClient, 0, len(users))
	for _, u := range users {
		c := driver.RemoteClient{RemoteID: u["name"], Label: u["comment"], UUID: u["password"], Enabled: u["disabled"] != "true"}
		if c.DataLimitBytes, c.RateLimitBps, err = permissive(held[u["name"]]); err != nil {
			return nil, driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("user %q: %w", u["name"], err))
		}
		out = append(out, c)
	}
	return out, nil
}

// permissive is the largest ceiling and rate among limitations, where any one
// without a figure (0) makes the answer 0: no limit.
func permissive(limits []row) (ceilingBytes, rateBps int64, err error) {
	if len(limits) == 0 {
		return 0, 0, nil
	}
	ceilingUnbounded, rateUnbounded := false, false
	for _, l := range limits {
		c, err := quantity(l["transfer-limit"], 1024)
		if err != nil {
			return 0, 0, fmt.Errorf("transfer-limit %q: %w", l["transfer-limit"], err)
		}
		if c == 0 {
			ceilingUnbounded = true
		} else if c > ceilingBytes {
			ceilingBytes = c
		}
		for _, field := range []string{"rate-limit-rx", "rate-limit-tx"} {
			r, err := quantity(l[field], 1000)
			if err != nil {
				return 0, 0, fmt.Errorf("%s %q: %w", field, l[field], err)
			}
			if r == 0 {
				rateUnbounded = true
			} else if r > rateBps {
				rateBps = r
			}
		}
	}
	if ceilingUnbounded {
		ceilingBytes = 0
	}
	if rateUnbounded {
		rateBps = 0
	}
	return ceilingBytes, rateBps, nil
}

// CreateClient names the user after its uuid without hyphens — the User-Name
// the NAS will report, fixed for the client's life — and makes it the password
// the uuid itself, so a regenerated config is a new password. A retry after a
// create that died half way finishes the chain rather than failing on the
// rows the first attempt made.
func (d *Driver) CreateClient(ctx context.Context, req driver.CreateClientRequest) (driver.RemoteClient, error) {
	const op = "CreateClient"
	if !isProtocol(req.Protocol) {
		return driver.RemoteClient{}, driver.NewFault(driver.FaultUnsupported, op, 0,
			fmt.Errorf("user manager has no %q login", req.Protocol))
	}
	name := strings.ReplaceAll(req.UUID, "-", "")
	if name == "" {
		return driver.RemoteClient{}, driver.NewFault(driver.FaultProtocol, op, 0, errors.New("a client needs a uuid to be named after"))
	}
	err := d.ensureChain(ctx, op, name, transferLimit(req.NoDataLimit, req.DataLimitBytes), req.RateLimitBps, func() error {
		return d.ensureNamed(ctx, op, "user", name, userBody(req.UUID, req.ClaimTag, req.Enabled))
	})
	if err != nil {
		return driver.RemoteClient{}, err
	}
	return driver.RemoteClient{
		RemoteID: name, Label: req.ClaimTag, UUID: req.UUID, Enabled: req.Enabled,
		DataLimitBytes: createdLimit(req), RateLimitBps: max(req.RateLimitBps, 0),
	}, nil
}

// UpdateClient writes the whole client as it should now be, and re-makes any
// part of its chain an operator removed. A user that is gone is not re-made:
// that is a delete, reported as the router's not-found.
func (d *Driver) UpdateClient(ctx context.Context, req driver.UpdateClientRequest) error {
	const op = "UpdateClient"
	return d.ensureChain(ctx, op, req.RemoteID, transferLimit(req.NoDataLimit, req.DataLimitBytes), req.RateLimitBps, func() error {
		return d.patch(ctx, op, "user", req.RemoteID, userBody(req.UUID, req.ClaimTag, req.Enabled))
	})
}

// SetClientEnabled refuses or allows the next login. User Manager does not
// cut a session that is already open.
func (d *Driver) SetClientEnabled(ctx context.Context, remoteID string, enabled bool) error {
	return d.patch(ctx, "SetClientEnabled", "user", remoteID, row{"disabled": disabled(enabled)})
}

// DeleteClient removes the chain: the user's profile links first, since the
// router keeps a user that still holds one, then the user, then its own
// limitation and profile. Every step treats "already gone" as done.
func (d *Driver) DeleteClient(ctx context.Context, remoteID string) error {
	const op = "DeleteClient"
	chain := chainName(remoteID)
	links, err := d.list(ctx, op, "user-profile", url.Values{"user": {remoteID}})
	if err != nil {
		return err
	}
	for _, l := range links {
		if err := d.remove(ctx, op, "user-profile", l[".id"]); err != nil {
			return err
		}
	}
	if err := d.remove(ctx, op, "user", remoteID); err != nil {
		return err
	}
	links, err = d.list(ctx, op, "profile-limitation", url.Values{"profile": {chain}})
	if err != nil {
		return err
	}
	for _, l := range links {
		if err := d.remove(ctx, op, "profile-limitation", l[".id"]); err != nil {
			return err
		}
	}
	if err := d.remove(ctx, op, "profile", chain); err != nil {
		return err
	}
	return d.remove(ctx, op, "limitation", chain)
}

// SetClientDataLimit writes the user's own limitation, one request.
func (d *Driver) SetClientDataLimit(ctx context.Context, remoteID string, ceilingBytes int64) error {
	body := limitationBody(transferLimit(false, ceilingBytes), 0)
	delete(body, "rate-limit-rx")
	delete(body, "rate-limit-tx")
	return d.patch(ctx, "SetClientDataLimit", "limitation", chainName(remoteID), body)
}

// SetClientIPLimit: User Manager has no per-user address limit it lets us write.
// "No limit" is already true, and anything else is refused rather than believed.
func (d *Driver) SetClientIPLimit(_ context.Context, _ string, limit int) error {
	if limit <= 0 {
		return nil
	}
	return driver.NewFault(driver.FaultUnsupported, "SetClientIPLimit", 0, errors.New("User Manager has no per-user address limit"))
}

func (d *Driver) SetClientRateLimit(ctx context.Context, remoteID string, rateBps int64) error {
	return d.patch(ctx, "SetClientRateLimit", "limitation", chainName(remoteID), rateBody(rateBps))
}

// GetUsage reads the open sessions, one request. A closed session's last
// figure came in its Stop, to the receiver; reading it again here would offer
// the same bytes twice. The filter is also applied here, so a router that
// ignored it returns more rows, never more readings.
func (d *Driver) GetUsage(ctx context.Context) ([]driver.ClientUsage, error) {
	return d.usage(ctx, "GetUsage", nil)
}

// GetUsageFor is served from the one bulk read: User Manager filters sessions
// by one user at a time, and a request per user is what catalog 8.4 forbids.
// An empty set sends nothing.
func (d *Driver) GetUsageFor(ctx context.Context, remoteIDs []string) ([]driver.ClientUsage, error) {
	if len(remoteIDs) == 0 {
		return nil, nil
	}
	want := map[string]bool{}
	for _, id := range remoteIDs {
		want[id] = true
	}
	return d.usage(ctx, "GetUsageFor", want)
}

func (d *Driver) usage(ctx context.Context, op string, want map[string]bool) ([]driver.ClientUsage, error) {
	sessions, err := d.list(ctx, op, "session", url.Values{"active": {"true"}})
	if err != nil {
		return nil, err
	}
	at := time.Now()
	out := make([]driver.ClientUsage, 0, len(sessions))
	for _, s := range sessions {
		if s["active"] != "true" || (want != nil && !want[s["user"]]) {
			continue
		}
		up, errUp := strconv.ParseInt(s["upload"], 10, 64)
		down, errDown := strconv.ParseInt(s["download"], 10, 64)
		if err := errors.Join(errUp, errDown); err != nil {
			return nil, driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("session %q: %w", s["acct-session-id"], err))
		}
		out = append(out, driver.ClientUsage{
			RemoteID: s["user"], UpBytes: up, DownBytes: down, ObservedAt: at, SessionID: s["acct-session-id"],
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].RemoteID < out[j].RemoteID })
	return out, nil
}

var _ driver.TotalsReader = (*Driver)(nil)

// ClientTotals reads User Manager's own total for every user — the figure a
// limitation's `transfer-limit` is checked against — in two requests: the
// users' names, then one `monitor ... once` over all of them (F-027-du). The
// answer comes back in the order asked. Names are listed first because an
// unknown name fails the whole command, and a user deleted on the router
// must not stop every other user being read. The total restarts with the
// user, which is the point: it shows a user made again by hand.
func (d *Driver) ClientTotals(ctx context.Context) ([]driver.ClientUsage, error) {
	const op = "ClientTotals"
	users, err := d.list(ctx, op, "user", url.Values{".proplist": {"name"}})
	if err != nil || len(users) == 0 {
		return nil, err
	}
	names := make([]string, len(users))
	for i, u := range users {
		names[i] = u["name"]
	}
	var answers []row
	body := row{"numbers": strings.Join(names, ","), "once": ""}
	if err := d.call(ctx, op, http.MethodPost, []string{"user", "monitor"}, nil, body, &answers); err != nil {
		return nil, err
	}
	if len(answers) != len(names) {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0,
			fmt.Errorf("monitor answered %d users for %d asked", len(answers), len(names)))
	}
	at := time.Now()
	out := make([]driver.ClientUsage, len(names))
	for i, a := range answers {
		up, errUp := quantity(a["total-upload"], 1024)
		down, errDown := quantity(a["total-download"], 1024)
		if err := errors.Join(errUp, errDown); err != nil {
			return nil, driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("user %q: %w", names[i], err))
		}
		out[i] = driver.ClientUsage{RemoteID: names[i], UpBytes: up, DownBytes: down, ObservedAt: at}
	}
	return out, nil
}

// ResetUsage: a session's counters end with the session, and nothing here
// zeroes one.
func (d *Driver) ResetUsage(context.Context, string) error {
	return driver.NewFault(driver.FaultUnsupported, "ResetUsage", 0, errors.New("user manager counters are per session"))
}

// BuildLink: a PPP login is a username and a password, not a link.
func (d *Driver) BuildLink(context.Context, driver.RemoteClient, driver.Inbound) (string, error) {
	return "", driver.NewFault(driver.FaultUnsupported, "BuildLink", 0, errors.New("user manager serves no links"))
}

func (d *Driver) SubscriptionURL(context.Context, string) (string, bool) { return "", false }

// ClientLinks: none to give (contract.links.md). A PPP client is configured
// with its name and password, not a link.
func (d *Driver) ClientLinks(context.Context, driver.RemoteClient) ([]string, error) { return nil, nil }

func isProtocol(p string) bool {
	for _, known := range protocols {
		if p == known {
			return true
		}
	}
	return false
}
