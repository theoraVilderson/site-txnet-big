// Package sanaee is the driver for 3x-ui panels by MHSanaei (F-027-ah), the
// family known as "Sanaee". Pull, cumulative, and the panel enforces its own
// per-client traffic total, so it carries ADR-0072 as Marzban does.
//
// 3x-ui is shaped differently from Marzban in three ways the driver absorbs:
//
//   - the session is a cookie from a form login, and every reply is a
//     `{success, msg, obj}` envelope whose failures arrive as a 200 with
//     success=false. A request with no valid session is a 404 on v2 (the API
//     hides itself) and a 401 on older versions; both get one login and one
//     retry.
//   - a client lives inside its inbound: its settings are an element of the
//     inbound's `settings` JSON string, and its counters are a row of the
//     inbound's `clientStats`. The client's `email` is unique across the panel
//     and is the key of its counters, so it is our RemoteID.
//   - writing one field of a client means writing the whole client, sent to
//     the key 3x-ui finds it by (the uuid, or a trojan client's password). So
//     every write reads the panel first.
//
// Two of the family's defaults are the opposite of ours, held at the wire:
//
//   - a `totalGB` of 0 (a byte figure, despite the name) is unlimited on
//     3x-ui, and a ceiling of zero is a cut-off here. Zero is written as one
//     byte.
//   - a `reset` other than 0 zeroes the client's counter every that many days.
//     Every write sets 0, so we stay the only writer of the quota.
package sanaee

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"network-service/internal/driver"
)

// Credentials is a 3x-ui panel login, read out of the owner's vault by
// internal/opener.
type Credentials struct {
	Username string
	Password string
}

// Driver is one 3x-ui panel. It is safe for concurrent use; driver.Pace is
// what keeps concurrent use from becoming a flood.
type Driver struct {
	base  *url.URL
	creds Credentials
	http  *http.Client
	// served is where users connect when an inbound listens on every
	// address: the panel's clientBaseUrl, else base (ADR-0088).
	served *url.URL

	mu      sync.Mutex
	cookies []*http.Cookie
}

var _ driver.Driver = (*Driver)(nil)

// protocols are the inbound protocols this driver provisions clients on.
// Shadowsocks is not one: a 2022 cipher's client key is a base64 key of the
// cipher's length, and the config's uuid is not one.
var protocols = []string{"vless", "vmess", "trojan"}

// New builds a driver over the panel at baseURL, which includes the panel's
// web base path when it has one. clientBaseURL, when set, is the host users
// connect to on an inbound that listens on every address (ADR-0088). Nothing is sent until the first call.
func New(baseURL, clientBaseURL string, creds Credentials, client *http.Client) (*Driver, error) {
	base, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("sanaee: base url %q is not an absolute url", baseURL)
	}
	served := base
	if strings.TrimSpace(clientBaseURL) != "" {
		u, err := url.Parse(strings.TrimRight(strings.TrimSpace(clientBaseURL), "/"))
		if err != nil || u.Scheme == "" || u.Host == "" {
			return nil, fmt.Errorf("sanaee: client base url %q is not an absolute url", clientBaseURL)
		}
		served = u
	}
	if client == nil {
		// No client timeout: the caller's context is the deadline (driver.Driver).
		client = &http.Client{}
	}
	return &Driver{base: base, creds: creds, http: client, served: served}, nil
}

// ---- wire ------------------------------------------------------------------

type envelope struct {
	Success bool            `json:"success"`
	Msg     string          `json:"msg"`
	Obj     json.RawMessage `json:"obj"`
}

// client is one element of an inbound's settings.clients. Fields this driver
// does not own (limitIp, tgId, flow) are carried through a write unchanged.
type client struct {
	ID         string `json:"id,omitempty"`
	Password   string `json:"password,omitempty"`
	Email      string `json:"email"`
	Enable     bool   `json:"enable"`
	TotalGB    int64  `json:"totalGB"`
	ExpiryTime int64  `json:"expiryTime"`
	Comment    string `json:"comment"`
	SubID      string `json:"subId"`
	Reset      int    `json:"reset"`
	LimitIP    int    `json:"limitIp"`
	TgID       any    `json:"tgId,omitempty"`
	Flow       string `json:"flow,omitempty"`
	Security   string `json:"security,omitempty"`
}

type clientStat struct {
	Email string `json:"email"`
	Up    int64  `json:"up"`
	Down  int64  `json:"down"`
	Total int64  `json:"total"`
}

type inbound struct {
	ID          int          `json:"id"`
	Enable      bool         `json:"enable"`
	Port        int          `json:"port"`
	Protocol    string       `json:"protocol"`
	Tag         string       `json:"tag"`
	Settings    string       `json:"settings"`
	ClientStats []clientStat `json:"clientStats"`
	// Listen, Remark and StreamSettings are what a client's line is built
	// from (ClientLinks, ADR-0088).
	Listen         string `json:"listen"`
	Remark         string `json:"remark"`
	StreamSettings string `json:"streamSettings"`
}

// found is one client where the panel holds it: its settings, its counters,
// and the inbound it belongs to.
type found struct {
	inbound  inbound
	client   client
	stat     clientStat
	hasStat  bool
	protocol string
}

// key is what 3x-ui finds a client by in updateClient and delClient: the
// uuid, or the password of a trojan client.
func (f found) key() string {
	if f.protocol == "trojan" {
		return f.client.Password
	}
	return f.client.ID
}

func (f found) remote() driver.RemoteClient {
	c := driver.RemoteClient{
		RemoteID:        f.client.Email,
		Label:           f.client.Comment,
		UUID:            f.client.ID + f.client.Password,
		InboundRemoteID: strconv.Itoa(f.inbound.ID),
		Enabled:         f.client.Enable,
		DataLimitBytes:  f.client.TotalGB,
	}
	// The counters' row is what 3x-ui's depletion job checks, so its total is
	// the ceiling actually enforced; the settings copy is only its source.
	if f.hasStat {
		c.DataLimitBytes = f.stat.Total
	}
	// A negative expiry is a delayed start in days, not a date.
	if f.client.ExpiryTime > 0 {
		c.ExpiresAt = time.UnixMilli(f.client.ExpiryTime).UTC()
	}
	return c
}

// clients flattens every inbound's clients. An inbound whose settings do not
// parse is a protocol fault: skipping it would drop its clients from a pass.
func clients(op string, list []inbound) ([]found, error) {
	var out []found
	for _, in := range list {
		var settings struct {
			Clients []client `json:"clients"`
		}
		if err := json.Unmarshal([]byte(in.Settings), &settings); err != nil {
			return nil, driver.NewFault(driver.FaultProtocol, op, 0,
				fmt.Errorf("inbound %d settings: %w", in.ID, err))
		}
		stats := make(map[string]clientStat, len(in.ClientStats))
		for _, s := range in.ClientStats {
			stats[s.Email] = s
		}
		for _, c := range settings.Clients {
			s, ok := stats[c.Email]
			out = append(out, found{inbound: in, client: c, stat: s, hasStat: ok, protocol: in.Protocol})
		}
	}
	return out, nil
}

// ceiling is a ceiling as 3x-ui must be told it: never 0, which it reads as
// unlimited (package doc).
func ceiling(bytes int64) int64 {
	if bytes < 1 {
		return 1
	}
	return bytes
}

// limit is the figure a create or an update writes: 3x-ui's own 0 for a client
// wanted with no limit (F-111-r), a ceiling otherwise.
func limit(none bool, bytes int64) int64 {
	if none {
		return 0
	}
	return ceiling(bytes)
}

func expiry(at time.Time) int64 {
	if at.IsZero() {
		return 0
	}
	return at.UnixMilli()
}

func credential(c *client, protocol, id string) {
	c.ID, c.Password = "", ""
	if protocol == "trojan" {
		c.Password = id
	} else {
		c.ID = id
	}
}

// newSubID is the client's subscription token. It is a secret — whoever has
// it has the client's links — so it is random, not derived.
func newSubID() (string, error) {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	for i, b := range raw {
		raw[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(raw), nil
}

// ---- transport -------------------------------------------------------------

// call sends one request with the current session. A 401 or a 404 may be an
// expired session (package doc), so it is answered by one login and one retry;
// a login refused is a blocked fault and is not retried (contract.budget.md).
// A 404 that survives the fresh login is a real one.
func (d *Driver) call(ctx context.Context, op, method string, path []string, body, out any) error {
	cookies, err := d.currentSession(ctx, op)
	if err != nil {
		return err
	}
	err = d.do(ctx, op, method, path, body, out, cookies)
	var fault *driver.Fault
	if !errors.As(err, &fault) || (fault.Status != http.StatusUnauthorized && fault.Status != http.StatusNotFound) {
		return err
	}
	if cookies, err = d.login(ctx, op); err != nil {
		return err
	}
	return d.do(ctx, op, method, path, body, out, cookies)
}

func (d *Driver) currentSession(ctx context.Context, op string) ([]*http.Cookie, error) {
	d.mu.Lock()
	cookies := d.cookies
	d.mu.Unlock()
	if cookies != nil {
		return cookies, nil
	}
	return d.login(ctx, op)
}

// login posts the form and keeps whatever cookies the panel set: the cookie's
// name has changed between versions, and no version is asked for.
func (d *Driver) login(ctx context.Context, op string) ([]*http.Cookie, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.cookies = nil
	form := url.Values{"username": {d.creds.Username}, "password": {d.creds.Password}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.base.JoinPath("login").String(),
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	resp, err := d.roundTrip(ctx, op, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var env envelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("decoding the login answer: %w", err))
	}
	if !env.Success {
		return nil, driver.NewFault(driver.FaultBlocked, op, resp.StatusCode, fmt.Errorf("login refused: %s", env.Msg))
	}
	if len(resp.Cookies()) == 0 {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0, errors.New("login set no session cookie"))
	}
	d.cookies = resp.Cookies()
	return d.cookies, nil
}

func (d *Driver) do(ctx context.Context, op, method string, path []string, body, out any, cookies []*http.Cookie) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return driver.NewFault(driver.FaultProtocol, op, 0, err)
		}
		reader = strings.NewReader(string(raw))
	}
	req, err := http.NewRequestWithContext(ctx, method, d.base.JoinPath(path...).String(), reader)
	if err != nil {
		return driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	// Marks the request as the panel's own ajax, so an expired session is a
	// status code rather than a redirect to the login page.
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	for _, c := range cookies {
		req.AddCookie(c)
	}
	resp, err := d.roundTrip(ctx, op, req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var env envelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return driver.NewFault(driver.FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, err))
		}
		return driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("decoding the answer: %w", err))
	}
	if !env.Success {
		return driver.NewFault(driver.FaultProtocol, op, resp.StatusCode, fmt.Errorf("panel refused: %s", env.Msg))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(env.Obj, out); err != nil {
		return driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("decoding obj: %w", err))
	}
	return nil
}

// roundTrip is where every transport and status failure is classified
// (driver.Fault). A success=false inside a 200 is classified by the caller.
func (d *Driver) roundTrip(ctx context.Context, op string, req *http.Request) (*http.Response, error) {
	resp, err := d.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, driver.NewFault(driver.FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, err))
		}
		return nil, driver.NewFault(driver.FaultUnavailable, op, 0, err)
	}
	if resp.StatusCode >= 300 {
		defer resp.Body.Close()
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		fault := driver.FaultForStatus(op, resp.StatusCode, fmt.Errorf("%s", strings.TrimSpace(string(detail))))
		if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && seconds > 0 {
			fault.RetryAfter = time.Duration(seconds) * time.Second
		}
		return nil, fault
	}
	return resp, nil
}

func (d *Driver) list(ctx context.Context, op string) ([]inbound, time.Time, error) {
	var list []inbound
	if err := d.call(ctx, op, http.MethodGet, []string{"panel", "api", "inbounds", "list"}, nil, &list); err != nil {
		return nil, time.Time{}, err
	}
	return list, time.Now(), nil
}

// find reads the panel and returns one client. ok is false when no inbound
// holds it.
func (d *Driver) find(ctx context.Context, op, remoteID string) (found, bool, error) {
	list, _, err := d.list(ctx, op)
	if err != nil {
		return found{}, false, err
	}
	all, err := clients(op, list)
	if err != nil {
		return found{}, false, err
	}
	for _, f := range all {
		if f.client.Email == remoteID {
			return f, true, nil
		}
	}
	return found{}, false, nil
}

func (d *Driver) mustFind(ctx context.Context, op, remoteID string) (found, error) {
	f, ok, err := d.find(ctx, op, remoteID)
	if err == nil && !ok {
		err = driver.NewFault(driver.FaultProtocol, op, http.StatusNotFound, fmt.Errorf("no client %q on the panel", remoteID))
	}
	return f, err
}

// write sends the whole client, as it should now be, to the inbound it lives
// on. Every write holds the reset at 0 (package doc).
func (d *Driver) write(ctx context.Context, op string, path []string, inboundID int, c client) error {
	c.Reset = 0
	settings, err := json.Marshal(map[string][]client{"clients": {c}})
	if err != nil {
		return driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	body := map[string]any{"id": inboundID, "settings": string(settings)}
	return d.call(ctx, op, http.MethodPost, path, body, nil)
}

// update applies change to the client as the panel holds it now, and writes
// it back to the key the panel knows it by.
func (d *Driver) update(ctx context.Context, op, remoteID string, change func(*client)) error {
	f, err := d.mustFind(ctx, op, remoteID)
	if err != nil {
		return err
	}
	key := f.key()
	next := f.client
	change(&next)
	return d.write(ctx, op, []string{"panel", "api", "inbounds", "updateClient", key}, f.inbound.ID, next)
}

// ---- the driver ------------------------------------------------------------

// Capabilities proves the login, then answers for the family. The one
// per-client choice that could change a row, the auto-reset, is written 0 by
// us on every write.
func (d *Driver) Capabilities(ctx context.Context) (driver.Capabilities, error) {
	if err := d.HealthCheck(ctx); err != nil {
		return driver.Capabilities{}, err
	}
	yes := func(detail string) driver.Answer { return driver.Answer{Supported: true, Detail: detail} }
	no := func(detail string) driver.Answer { return driver.Answer{Supported: false, Detail: detail} }
	return driver.Capabilities{
		Version:    driver.CapabilitiesVersion,
		AnsweredAt: time.Now().UTC(),
		Answers: map[driver.RowKey]driver.Answer{
			driver.RowPerClientUsage:          yes("clientStats up and down per client email"),
			driver.RowBulkUsageInOneCall:      yes("GET /panel/api/inbounds/list carries every client's counters"),
			driver.RowUsageForNamedSubset:     no("getClientTraffics reads one email per request; a subset is served from the bulk call"),
			driver.RowUsageResetSupported:     yes("POST /panel/api/inbounds/{id}/resetClientTraffic/{email}"),
			driver.RowCounterSurvivesUpdate:   yes("updateClient keeps up and down while the email is unchanged, and we never change it"),
			driver.RowPerClientDataLimit:      yes("totalGB, enforced by 3x-ui's depletion job; zero is written as one byte, since 0 is unlimited there"),
			driver.RowDataLimitCountsSameByte: yes("the total is checked against up plus down, the figures we read"),
			driver.RowPerClientRateLimit:      no("3x-ui has no per-client bandwidth cap; limitIp counts addresses"),
			driver.RowEnableDisableClient:     yes("the client's enable flag"),
			driver.RowClientLifecycle:         yes("addClient, updateClient, delClient; an inbound's last client cannot be deleted and is disabled instead"),
			driver.RowStableRemoteID:          yes("the email, which we never change"),
			driver.RowClientLabelStorable:     yes("the comment field"),
			driver.RowNativeSubscriptionLink:  yes("the panel's subscription server, by the client's subId"),
			driver.RowServerSideExpiry:        yes("expiryTime, enforced by 3x-ui itself"),
			driver.RowInternalCreditDisabled:  yes("no credit of its own; the client's reset is written 0 on every write"),
		},
	}, nil
}

// HealthCheck reads the inbound list: 3x-ui has no cheaper call every
// version serves behind a session.
func (d *Driver) HealthCheck(ctx context.Context) error {
	_, _, err := d.list(ctx, "HealthCheck")
	return err
}

func (d *Driver) ListInbounds(ctx context.Context) ([]driver.Inbound, error) {
	list, _, err := d.list(ctx, "ListInbounds")
	if err != nil {
		return nil, err
	}
	out := make([]driver.Inbound, 0, len(list))
	for _, in := range list {
		out = append(out, driver.Inbound{
			RemoteID: strconv.Itoa(in.ID), Tag: in.Tag, Protocol: in.Protocol, Port: in.Port, Enabled: in.Enable,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Tag < out[j].Tag })
	return out, nil
}

// ListClients reads the panel, never our last write: the limit reported is
// the one 3x-ui's counters row holds now.
func (d *Driver) ListClients(ctx context.Context) ([]driver.RemoteClient, error) {
	list, _, err := d.list(ctx, "ListClients")
	if err != nil {
		return nil, err
	}
	all, err := clients("ListClients", list)
	if err != nil {
		return nil, err
	}
	out := make([]driver.RemoteClient, 0, len(all))
	for _, f := range all {
		out = append(out, f.remote())
	}
	return out, nil
}

// CreateClient names the client by its email: the name provisioning chose
// (`<subscription key>-<n>`, F-114-n), else its uuid without hyphens. Unique on
// the panel, and never changed, because the email is the key of the client's
// counters. The clients of one purchase share the subscription key as their
// subId, so the panel shows them as one account; a client of no purchase gets
// a random one. It is created under its first block and its enabled state in
// one request.
func (d *Driver) CreateClient(ctx context.Context, req driver.CreateClientRequest) (driver.RemoteClient, error) {
	const op = "CreateClient"
	if !isProtocol(req.Protocol) {
		return driver.RemoteClient{}, driver.NewFault(driver.FaultUnsupported, op, 0,
			fmt.Errorf("3x-ui clients are provisioned on %v, not %q", protocols, req.Protocol))
	}
	inboundID, err := strconv.Atoi(req.InboundRemoteID)
	if err != nil {
		return driver.RemoteClient{}, driver.NewFault(driver.FaultProtocol, op, 0,
			fmt.Errorf("inbound %q is not a 3x-ui inbound id", req.InboundRemoteID))
	}
	subID := req.SubscriptionKey
	if subID == "" {
		if subID, err = newSubID(); err != nil {
			return driver.RemoteClient{}, driver.NewFault(driver.FaultProtocol, op, 0, err)
		}
	}
	email := req.Name
	if email == "" {
		email = strings.ReplaceAll(req.UUID, "-", "")
	}
	c := client{
		Email:      email,
		Enable:     req.Enabled,
		TotalGB:    limit(req.NoDataLimit, req.DataLimitBytes),
		ExpiryTime: expiry(req.ExpiresAt),
		Comment:    req.ClaimTag,
		SubID:      subID,
	}
	credential(&c, req.Protocol, req.UUID)
	if err := d.write(ctx, op, []string{"panel", "api", "inbounds", "addClient"}, inboundID, c); err != nil {
		return driver.RemoteClient{}, err
	}
	return found{inbound: inbound{ID: inboundID}, client: c, protocol: req.Protocol}.remote(), nil
}

// UpdateClient writes the whole client as it should now be. The inbound and
// the protocol are the ones the client has: 3x-ui cannot move a client.
func (d *Driver) UpdateClient(ctx context.Context, req driver.UpdateClientRequest) error {
	const op = "UpdateClient"
	f, err := d.mustFind(ctx, op, req.RemoteID)
	if err != nil {
		return err
	}
	if req.InboundRemoteID != "" && req.InboundRemoteID != strconv.Itoa(f.inbound.ID) {
		return driver.NewFault(driver.FaultUnsupported, op, 0,
			fmt.Errorf("3x-ui cannot move client %q to inbound %s", req.RemoteID, req.InboundRemoteID))
	}
	key := f.key()
	next := f.client
	credential(&next, f.protocol, req.UUID)
	next.Enable = req.Enabled
	next.TotalGB = limit(req.NoDataLimit, req.DataLimitBytes)
	next.ExpiryTime = expiry(req.ExpiresAt)
	next.Comment = req.ClaimTag
	return d.write(ctx, op, []string{"panel", "api", "inbounds", "updateClient", key}, f.inbound.ID, next)
}

func (d *Driver) SetClientEnabled(ctx context.Context, remoteID string, enabled bool) error {
	return d.update(ctx, "SetClientEnabled", remoteID, func(c *client) { c.Enable = enabled })
}

// DeleteClient removes the client. A client already gone is done. 3x-ui
// refuses to delete the last client of an inbound, so that one is disabled
// and the delete is reported unsupported — never as done, since it is still
// there.
func (d *Driver) DeleteClient(ctx context.Context, remoteID string) error {
	const op = "DeleteClient"
	f, ok, err := d.find(ctx, op, remoteID)
	if err != nil || !ok {
		return err
	}
	var siblings int
	var settings struct {
		Clients []client `json:"clients"`
	}
	if err := json.Unmarshal([]byte(f.inbound.Settings), &settings); err == nil {
		siblings = len(settings.Clients)
	}
	if siblings == 1 {
		next := f.client
		next.Enable = false
		if err := d.write(ctx, op, []string{"panel", "api", "inbounds", "updateClient", f.key()}, f.inbound.ID, next); err != nil {
			return err
		}
		return driver.NewFault(driver.FaultUnsupported, op, 0,
			fmt.Errorf("client %q is the last on inbound %d, which 3x-ui keeps; it is disabled", remoteID, f.inbound.ID))
	}
	return d.call(ctx, op, http.MethodPost,
		[]string{"panel", "api", "inbounds", strconv.Itoa(f.inbound.ID), "delClient", f.key()}, nil, nil)
}

// SetClientDataLimit writes the ceiling 3x-ui enforces. Raising it above what
// was used is also what lets a depleted client through again.
func (d *Driver) SetClientDataLimit(ctx context.Context, remoteID string, ceilingBytes int64) error {
	return d.update(ctx, "SetClientDataLimit", remoteID, func(c *client) { c.TotalGB = ceiling(ceilingBytes) })
}

// SetClientRateLimit: 3x-ui has no per-client bandwidth cap. "No cap" is
// already true, and anything else is refused rather than believed.
func (d *Driver) SetClientRateLimit(_ context.Context, _ string, rateBps int64) error {
	if rateBps <= 0 {
		return nil
	}
	return driver.NewFault(driver.FaultUnsupported, "SetClientRateLimit", 0, errors.New("3x-ui has no per-client rate limit"))
}

func (d *Driver) GetUsage(ctx context.Context) ([]driver.ClientUsage, error) {
	return d.usage(ctx, "GetUsage", nil)
}

// GetUsageFor is served from the bulk call, filtered: one request whatever
// the subset, since 3x-ui reads one email per request otherwise. An empty set
// is not read.
func (d *Driver) GetUsageFor(ctx context.Context, remoteIDs []string) ([]driver.ClientUsage, error) {
	if len(remoteIDs) == 0 {
		return nil, nil
	}
	want := make(map[string]bool, len(remoteIDs))
	for _, id := range remoteIDs {
		want[id] = true
	}
	return d.usage(ctx, "GetUsageFor", want)
}

// usage reads the counters rows, which carry the real up/down split.
func (d *Driver) usage(ctx context.Context, op string, want map[string]bool) ([]driver.ClientUsage, error) {
	list, at, err := d.list(ctx, op)
	if err != nil {
		return nil, err
	}
	var out []driver.ClientUsage
	for _, in := range list {
		for _, s := range in.ClientStats {
			if want != nil && !want[s.Email] {
				continue
			}
			out = append(out, driver.ClientUsage{RemoteID: s.Email, UpBytes: s.Up, DownBytes: s.Down, ObservedAt: at})
		}
	}
	return out, nil
}

func (d *Driver) ResetUsage(ctx context.Context, remoteID string) error {
	const op = "ResetUsage"
	f, err := d.mustFind(ctx, op, remoteID)
	if err != nil {
		return err
	}
	return d.call(ctx, op, http.MethodPost,
		[]string{"panel", "api", "inbounds", strconv.Itoa(f.inbound.ID), "resetClientTraffic", remoteID}, nil, nil)
}

// BuildLink: 3x-ui assembles share links in its browser page, from the
// inbound's stream settings, and serves them only through its subscription
// server. A link assembled here would be a second implementation of that page
// and would disagree with it, so the subscription is the link.
func (d *Driver) BuildLink(context.Context, driver.RemoteClient, driver.Inbound) (string, error) {
	return "", driver.NewFault(driver.FaultUnsupported, "BuildLink", 0,
		errors.New("3x-ui serves links through its subscription server; use SubscriptionURL"))
}

// SubscriptionURL builds the address 3x-ui's own page shows for a client: the
// panel's subURI when it is set, else its sub server's scheme, domain (or the
// panel's host), port and path, then the client's subId. A panel with the
// subscription server off answers false.
func (d *Driver) SubscriptionURL(ctx context.Context, remoteID string) (string, bool) {
	const op = "SubscriptionURL"
	f, ok, err := d.find(ctx, op, remoteID)
	if err != nil || !ok {
		return "", false
	}
	u, ok, err := d.subscription(ctx, op, f.client.SubID)
	return u, ok && err == nil
}

// ClientLinks is the client's lines, built from the inbound it lives on as
// x-ui's own page builds them (driver.XrayLines, ADR-0088). The sub server is
// not read. An inbound the port does not cover answers no lines and no error;
// the one read is the client list, and a client it does not hold is a fault.
func (d *Driver) ClientLinks(ctx context.Context, client driver.RemoteClient) ([]string, error) {
	const op = "ClientLinks"
	f, err := d.mustFind(ctx, op, client.RemoteID)
	if err != nil {
		return nil, err
	}
	return driver.XrayLines(
		driver.XrayInbound{
			Listen: f.inbound.Listen, Port: f.inbound.Port, Protocol: f.inbound.Protocol,
			Remark: f.inbound.Remark, Settings: f.inbound.Settings, StreamSettings: f.inbound.StreamSettings,
		},
		driver.XrayClient{
			ID: f.client.ID, Password: f.client.Password, Email: f.client.Email,
			Flow: f.client.Flow, Security: f.client.Security,
		},
		d.served.Hostname(),
	), nil
}

// subscription builds the address from the panel's settings. ok is false for
// no subId or the sub server off; err is a settings read that failed.
func (d *Driver) subscription(ctx context.Context, op, subID string) (string, bool, error) {
	if subID == "" {
		return "", false, nil
	}
	var s struct {
		SubEnable   bool   `json:"subEnable"`
		SubPort     int    `json:"subPort"`
		SubPath     string `json:"subPath"`
		SubDomain   string `json:"subDomain"`
		SubURI      string `json:"subURI"`
		SubCertFile string `json:"subCertFile"`
	}
	if err := d.call(ctx, op, http.MethodPost, []string{"panel", "setting", "all"}, nil, &s); err != nil {
		return "", false, err
	}
	if !s.SubEnable {
		return "", false, nil
	}
	if s.SubURI != "" {
		return strings.TrimRight(s.SubURI, "/") + "/" + subID, true, nil
	}
	scheme := "http"
	if s.SubCertFile != "" {
		scheme = "https"
	}
	host := s.SubDomain
	if host == "" {
		host = d.base.Hostname()
	}
	if s.SubPort != 0 && !(scheme == "https" && s.SubPort == 443) && !(scheme == "http" && s.SubPort == 80) {
		host += ":" + strconv.Itoa(s.SubPort)
	}
	path := "/" + strings.Trim(s.SubPath, "/") + "/"
	if path == "//" {
		path = "/"
	}
	return scheme + "://" + host + path + subID, true, nil
}

func isProtocol(p string) bool {
	for _, known := range protocols {
		if p == known {
			return true
		}
	}
	return false
}
