// Package threexui is the driver for 3x-ui v3.x panels by MHSanaei (F-027-bb),
// the `three_x_ui` family. v2.x panels are `sanaee`, a separate family: v3
// removed the routes a v2 driver writes through, so neither driver speaks the
// other's API (user, 2026-09-24). Pull, cumulative, and the panel enforces its
// own per-client total, so it carries ADR-0072 as Marzban does.
//
// What v3 changed, and the driver absorbs:
//
//   - a session is opened by GET /csrf-token, and the login and every POST
//     after it carry that token in X-CSRF-Token, or are a 403. A request with
//     no valid session is a 401 to the panel's own ajax; it gets one fresh
//     token, one login and one retry.
//   - a client is a record of its own under /panel/api/clients, keyed by its
//     email, attached to inbounds, and listed with its counters row in one
//     answer. The email is unique across the panel and keys the counters, so
//     it is our RemoteID.
//   - an update writes the whole client: a field left out is a field zeroed,
//     except the credentials and subId, which an empty value keeps. So every
//     write reads the client first and carries the fields we do not own.
//
// Two of the family's defaults are the opposite of ours, held at the wire:
//
//   - a `totalGB` of 0 (a byte figure, despite the name) is unlimited, and a
//     ceiling of zero is a cut-off here. Zero is written as one byte.
//   - a client can renew itself (`reset`, `resetDay`, `resetMax`) or zero its
//     counter on a cycle (`trafficReset`). Every write turns all four off, so
//     we stay the only writer of the quota.
package threexui

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
// internal/opener. v3 also takes an API token; the family signs in with the
// login, as `sanaee` does (user, 2026-09-24).
type Credentials struct {
	Username string
	Password string
}

// Driver is one 3x-ui v3 panel. It is safe for concurrent use; driver.Pace is
// what keeps concurrent use from becoming a flood.
type Driver struct {
	base  *url.URL
	creds Credentials
	http  *http.Client

	mu      sync.Mutex
	session *session
}

// session is a logged-in cookie jar and the CSRF token it was issued with.
type session struct {
	cookies []*http.Cookie
	token   string
}

var _ driver.Driver = (*Driver)(nil)

// protocols are the inbound protocols this driver provisions clients on, as
// `sanaee` does: a shadowsocks 2022 client key is not a uuid.
var protocols = []string{"vless", "vmess", "trojan"}

const csrfHeader = "X-CSRF-Token"

// New builds a driver over the panel at baseURL, which includes the panel's
// web base path when it has one. Nothing is sent until the first call.
func New(baseURL string, creds Credentials, client *http.Client) (*Driver, error) {
	base, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("threexui: base url %q is not an absolute url", baseURL)
	}
	if client == nil {
		// No client timeout: the caller's context is the deadline (driver.Driver).
		client = &http.Client{}
	}
	return &Driver{base: base, creds: creds, http: client}, nil
}

// ---- wire ------------------------------------------------------------------

type envelope struct {
	Success bool            `json:"success"`
	Msg     string          `json:"msg"`
	Obj     json.RawMessage `json:"obj"`
}

// record is one row of GET /panel/api/clients/list. `id` is the panel's row
// number, not the uuid, which is `uuid` here and `id` on the write.
type record struct {
	Email      string          `json:"email"`
	SubID      string          `json:"subId"`
	UUID       string          `json:"uuid"`
	Password   string          `json:"password"`
	Flow       string          `json:"flow"`
	Security   string          `json:"security"`
	Reverse    json.RawMessage `json:"reverse"`
	Auth       string          `json:"auth"`
	Secret     string          `json:"secret"`
	AdTag      string          `json:"adTag"`
	LimitIP    int             `json:"limitIp"`
	LimitHwid  int             `json:"limitHwid"`
	TotalGB    int64           `json:"totalGB"`
	ExpiryTime int64           `json:"expiryTime"`
	Enable     bool            `json:"enable"`
	TgID       int64           `json:"tgId"`
	Group      string          `json:"group"`
	Comment    string          `json:"comment"`
	InboundIds []int           `json:"inboundIds"`
	Traffic    *struct {
		Up    int64 `json:"up"`
		Down  int64 `json:"down"`
		Total int64 `json:"total"`
	} `json:"traffic"`
}

// wireClient is the client as v3's add and update read it (`model.Client`).
// The renewal fields have no omitempty: zero is the value we mean.
type wireClient struct {
	ID              string          `json:"id,omitempty"`
	Security        string          `json:"security,omitempty"`
	Password        string          `json:"password,omitempty"`
	Flow            string          `json:"flow,omitempty"`
	Reverse         json.RawMessage `json:"reverse,omitempty"`
	Auth            string          `json:"auth,omitempty"`
	Secret          string          `json:"secret,omitempty"`
	AdTag           string          `json:"adTag,omitempty"`
	Email           string          `json:"email"`
	LimitIP         int             `json:"limitIp"`
	TotalGB         int64           `json:"totalGB"`
	ExpiryTime      int64           `json:"expiryTime"`
	Enable          bool            `json:"enable"`
	TgID            int64           `json:"tgId"`
	SubID           string          `json:"subId"`
	Group           string          `json:"group,omitempty"`
	Comment         string          `json:"comment"`
	Reset           int             `json:"reset"`
	ResetDay        int             `json:"resetDay"`
	ResetMax        int             `json:"resetMax"`
	TrafficReset    string          `json:"trafficReset"`
	TrafficResetDay int             `json:"trafficResetDay,omitempty"`
}

// updateBody is POST clients/update/{email}: the client, and the device
// limit beside it, which the update also overwrites.
type updateBody struct {
	wireClient
	LimitHwid int `json:"limitHwid"`
}

// write is the record as it should be written back: every field we do not
// own carried through, the renewal knobs held off (package doc).
func (r record) write() wireClient {
	return noRenewal(wireClient{
		ID: r.UUID, Security: r.Security, Password: r.Password, Flow: r.Flow, Reverse: r.Reverse,
		Auth: r.Auth, Secret: r.Secret, AdTag: r.AdTag, Email: r.Email, LimitIP: r.LimitIP,
		TotalGB: r.TotalGB, ExpiryTime: r.ExpiryTime, Enable: r.Enable, TgID: r.TgID, SubID: r.SubID,
		Group: r.Group, Comment: r.Comment,
	})
}

func noRenewal(c wireClient) wireClient {
	c.Reset, c.ResetDay, c.ResetMax, c.TrafficReset, c.TrafficResetDay = 0, 0, 0, "never", 0
	return c
}

func (r record) remote() driver.RemoteClient {
	c := driver.RemoteClient{
		RemoteID:       r.Email,
		Label:          r.Comment,
		UUID:           r.UUID,
		Enabled:        r.Enable,
		DataLimitBytes: r.TotalGB,
	}
	if c.UUID == "" {
		c.UUID = r.Password
	}
	// A client can sit on several inbounds in v3; ours sit on one, and the
	// lowest id is the one reported.
	if len(r.InboundIds) > 0 {
		ids := append([]int(nil), r.InboundIds...)
		sort.Ints(ids)
		c.InboundRemoteID = strconv.Itoa(ids[0])
	}
	// The counters row is what 3x-ui's depletion job checks, so its total is
	// the ceiling actually enforced.
	if r.Traffic != nil {
		c.DataLimitBytes = r.Traffic.Total
	}
	// A negative expiry is a delayed start in days, not a date.
	if r.ExpiryTime > 0 {
		c.ExpiresAt = time.UnixMilli(r.ExpiryTime).UTC()
	}
	return c
}

// ceiling is a ceiling as 3x-ui must be told it: never 0, which it reads as
// unlimited (package doc).
func ceiling(bytes int64) int64 {
	if bytes < 1 {
		return 1
	}
	return bytes
}

func expiry(at time.Time) int64 {
	if at.IsZero() {
		return 0
	}
	return at.UnixMilli()
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

// call sends one request with the current session. A 401 is an expired
// session (package doc): one login and one retry. A login refused is a blocked
// fault and is not retried (contract.budget.md). A 404 is a real one: v3
// answers the panel's own ajax with a 401, so a 404 is a wrong base path.
func (d *Driver) call(ctx context.Context, op, method string, path []string, body, out any) error {
	s, err := d.currentSession(ctx, op)
	if err != nil {
		return err
	}
	err = d.do(ctx, op, method, path, body, out, s)
	var fault *driver.Fault
	if !errors.As(err, &fault) || fault.Status != http.StatusUnauthorized {
		return err
	}
	if s, err = d.login(ctx, op); err != nil {
		return err
	}
	return d.do(ctx, op, method, path, body, out, s)
}

func (d *Driver) currentSession(ctx context.Context, op string) (*session, error) {
	d.mu.Lock()
	s := d.session
	d.mu.Unlock()
	if s != nil {
		return s, nil
	}
	return d.login(ctx, op)
}

// login opens a session and signs it in: GET /csrf-token sets the cookie and
// answers the token, and POST /login must carry both. Cookies are kept by
// name, the latest winning, since the panel rewrites its session cookie on
// every save.
func (d *Driver) login(ctx context.Context, op string) (*session, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.session = nil

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.base.JoinPath("csrf-token").String(), nil)
	if err != nil {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	s := &session{}
	env, cookies, status, err := d.exchange(ctx, op, req)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(env.Obj, &s.token); err != nil || !env.Success || s.token == "" {
		return nil, driver.NewFault(driver.FaultProtocol, op, status, errors.New("the panel answered no csrf token"))
	}
	s.cookies = merge(nil, cookies)

	form := url.Values{"username": {d.creds.Username}, "password": {d.creds.Password}}
	req, err = http.NewRequestWithContext(ctx, http.MethodPost, d.base.JoinPath("login").String(),
		strings.NewReader(form.Encode()))
	if err != nil {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	s.sign(req)
	env, cookies, status, err = d.exchange(ctx, op, req)
	if err != nil {
		return nil, err
	}
	if !env.Success {
		return nil, driver.NewFault(driver.FaultBlocked, op, status, fmt.Errorf("login refused: %s", env.Msg))
	}
	s.cookies = merge(s.cookies, cookies)
	if len(s.cookies) == 0 {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0, errors.New("login set no session cookie"))
	}
	d.session = s
	return s, nil
}

// sign marks the request as the panel's own ajax, so an expired session is a
// status code rather than a redirect, and adds the session and its token.
func (s *session) sign(req *http.Request) {
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	req.Header.Set(csrfHeader, s.token)
	for _, c := range s.cookies {
		req.AddCookie(c)
	}
}

func merge(have, set []*http.Cookie) []*http.Cookie {
	out := make([]*http.Cookie, 0, len(have)+len(set))
	seen := map[string]int{}
	for _, c := range append(append([]*http.Cookie(nil), have...), set...) {
		if i, ok := seen[c.Name]; ok {
			out[i] = c
			continue
		}
		seen[c.Name] = len(out)
		out = append(out, c)
	}
	return out
}

func (d *Driver) do(ctx context.Context, op, method string, path []string, body, out any, s *session) error {
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
	s.sign(req)
	env, _, status, err := d.exchange(ctx, op, req)
	if err != nil {
		return err
	}
	if !env.Success {
		return driver.NewFault(driver.FaultProtocol, op, status, fmt.Errorf("panel refused: %s", env.Msg))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(env.Obj, out); err != nil {
		return driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("decoding obj: %w", err))
	}
	return nil
}

// exchange sends one request and decodes its envelope. Every transport and
// status failure is classified here (driver.Fault); a success=false inside a
// 200 is the caller's to classify.
func (d *Driver) exchange(ctx context.Context, op string, req *http.Request) (envelope, []*http.Cookie, int, error) {
	resp, err := d.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return envelope{}, nil, 0, driver.NewFault(driver.FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, err))
		}
		return envelope{}, nil, 0, driver.NewFault(driver.FaultUnavailable, op, 0, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		fault := driver.FaultForStatus(op, resp.StatusCode, fmt.Errorf("%s", strings.TrimSpace(string(detail))))
		if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && seconds > 0 {
			fault.RetryAfter = time.Duration(seconds) * time.Second
		}
		return envelope{}, nil, resp.StatusCode, fault
	}
	var env envelope
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return envelope{}, nil, 0, driver.NewFault(driver.FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, err))
		}
		return envelope{}, nil, 0, driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("decoding the answer: %w", err))
	}
	return env, resp.Cookies(), resp.StatusCode, nil
}

// list reads every client with its counters: one request, unpaged.
func (d *Driver) list(ctx context.Context, op string) ([]record, time.Time, error) {
	var list []record
	if err := d.call(ctx, op, http.MethodGet, []string{"panel", "api", "clients", "list"}, nil, &list); err != nil {
		return nil, time.Time{}, err
	}
	return list, time.Now(), nil
}

// find reads the panel and returns one client. ok is false when it is not
// there.
func (d *Driver) find(ctx context.Context, op, remoteID string) (record, bool, error) {
	list, _, err := d.list(ctx, op)
	if err != nil {
		return record{}, false, err
	}
	for _, r := range list {
		if r.Email == remoteID {
			return r, true, nil
		}
	}
	return record{}, false, nil
}

func (d *Driver) mustFind(ctx context.Context, op, remoteID string) (record, error) {
	r, ok, err := d.find(ctx, op, remoteID)
	if err == nil && !ok {
		err = driver.NewFault(driver.FaultProtocol, op, http.StatusNotFound, fmt.Errorf("no client %q on the panel", remoteID))
	}
	return r, err
}

// update applies change to the client as the panel holds it now, and writes
// the whole of it back (package doc).
func (d *Driver) update(ctx context.Context, op, remoteID string, change func(*wireClient)) error {
	r, err := d.mustFind(ctx, op, remoteID)
	if err != nil {
		return err
	}
	next := r.write()
	change(&next)
	return d.call(ctx, op, http.MethodPost, []string{"panel", "api", "clients", "update", r.Email},
		updateBody{wireClient: next, LimitHwid: r.LimitHwid}, nil)
}

// ---- the driver ------------------------------------------------------------

// Capabilities proves the login, then answers for the family. The renewal
// knobs that could change a row are written off by us on every write.
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
			driver.RowPerClientUsage:          yes("each client's traffic up and down, by its email"),
			driver.RowBulkUsageInOneCall:      yes("GET /panel/api/clients/list carries every client's counters, unpaged"),
			driver.RowUsageForNamedSubset:     no("clients/traffic reads one email per request; a subset is served from the bulk call"),
			driver.RowUsageResetSupported:     yes("POST /panel/api/clients/resetTraffic/{email}"),
			driver.RowCounterSurvivesUpdate:   yes("clients/update keeps up and down while the email is unchanged, and we never change it"),
			driver.RowPerClientDataLimit:      yes("totalGB, enforced by 3x-ui's depletion job; zero is written as one byte, since 0 is unlimited there"),
			driver.RowDataLimitCountsSameByte: yes("the total is checked against up plus down, the figures we read"),
			driver.RowPerClientRateLimit:      no("3x-ui has no per-client bandwidth cap; limitIp counts addresses"),
			driver.RowEnableDisableClient:     yes("the client's enable flag"),
			driver.RowClientLifecycle:         yes("clients/add, clients/update/{email}, clients/del/{email}"),
			driver.RowStableRemoteID:          yes("the email, which we never change"),
			driver.RowClientLabelStorable:     yes("the comment field"),
			driver.RowNativeSubscriptionLink:  yes("the panel's subscription server, by the client's subId"),
			driver.RowServerSideExpiry:        yes("expiryTime, enforced by 3x-ui itself"),
			driver.RowInternalCreditDisabled:  yes("no credit of its own; reset, resetDay, resetMax and trafficReset are written off on every write"),
		},
	}, nil
}

// HealthCheck reads the inbound list, which every v3 panel serves behind a
// session and which does not grow with the client count.
func (d *Driver) HealthCheck(ctx context.Context) error {
	_, err := d.inbounds(ctx, "HealthCheck")
	return err
}

type inbound struct {
	ID       int    `json:"id"`
	Enable   bool   `json:"enable"`
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
	Tag      string `json:"tag"`
}

func (d *Driver) inbounds(ctx context.Context, op string) ([]inbound, error) {
	var list []inbound
	err := d.call(ctx, op, http.MethodGet, []string{"panel", "api", "inbounds", "list"}, nil, &list)
	return list, err
}

func (d *Driver) ListInbounds(ctx context.Context) ([]driver.Inbound, error) {
	list, err := d.inbounds(ctx, "ListInbounds")
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
// the one the counters row holds now.
func (d *Driver) ListClients(ctx context.Context) ([]driver.RemoteClient, error) {
	list, _, err := d.list(ctx, "ListClients")
	if err != nil {
		return nil, err
	}
	out := make([]driver.RemoteClient, 0, len(list))
	for _, r := range list {
		out = append(out, r.remote())
	}
	return out, nil
}

// CreateClient names the client after its uuid without hyphens, as its email:
// unique on the panel, and never changed, because the email is the key of the
// client's counters. It is created under its first block and its enabled
// state in one request.
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
	subID, err := newSubID()
	if err != nil {
		return driver.RemoteClient{}, driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	r := record{
		Email:      strings.ReplaceAll(req.UUID, "-", ""),
		Enable:     req.Enabled,
		TotalGB:    ceiling(req.DataLimitBytes),
		ExpiryTime: expiry(req.ExpiresAt),
		Comment:    req.ClaimTag,
		SubID:      subID,
		InboundIds: []int{inboundID},
	}
	if req.Protocol == "trojan" {
		r.Password = req.UUID
	} else {
		r.UUID = req.UUID
	}
	body := map[string]any{"client": r.write(), "inboundIds": r.InboundIds}
	if err := d.call(ctx, op, http.MethodPost, []string{"panel", "api", "clients", "add"}, body, nil); err != nil {
		return driver.RemoteClient{}, err
	}
	return r.remote(), nil
}

// UpdateClient writes the whole client as it should now be. The inbound is
// the one the client has: the driver does not move a client.
func (d *Driver) UpdateClient(ctx context.Context, req driver.UpdateClientRequest) error {
	const op = "UpdateClient"
	r, err := d.mustFind(ctx, op, req.RemoteID)
	if err != nil {
		return err
	}
	if req.InboundRemoteID != "" && !attached(r, req.InboundRemoteID) {
		return driver.NewFault(driver.FaultUnsupported, op, 0,
			fmt.Errorf("3x-ui client %q is not on inbound %s, and the driver does not move it", req.RemoteID, req.InboundRemoteID))
	}
	next := r.write()
	// The credential goes where the client keeps it: the uuid, or a trojan
	// client's password.
	if r.UUID != "" {
		next.ID = req.UUID
	} else {
		next.Password = req.UUID
	}
	next.Enable = req.Enabled
	next.TotalGB = ceiling(req.DataLimitBytes)
	next.ExpiryTime = expiry(req.ExpiresAt)
	next.Comment = req.ClaimTag
	return d.call(ctx, op, http.MethodPost, []string{"panel", "api", "clients", "update", r.Email},
		updateBody{wireClient: next, LimitHwid: r.LimitHwid}, nil)
}

func attached(r record, inboundRemoteID string) bool {
	for _, id := range r.InboundIds {
		if strconv.Itoa(id) == inboundRemoteID {
			return true
		}
	}
	return false
}

func (d *Driver) SetClientEnabled(ctx context.Context, remoteID string, enabled bool) error {
	return d.update(ctx, "SetClientEnabled", remoteID, func(c *wireClient) { c.Enable = enabled })
}

// DeleteClient removes the client and its counters. A client already gone is
// done. v3 has no last-client rule: the record is the client's own.
func (d *Driver) DeleteClient(ctx context.Context, remoteID string) error {
	const op = "DeleteClient"
	_, ok, err := d.find(ctx, op, remoteID)
	if err != nil || !ok {
		return err
	}
	return d.call(ctx, op, http.MethodPost, []string{"panel", "api", "clients", "del", remoteID}, nil, nil)
}

// SetClientDataLimit writes the ceiling 3x-ui enforces. Raising it above what
// was used is also what lets a depleted client through again.
func (d *Driver) SetClientDataLimit(ctx context.Context, remoteID string, ceilingBytes int64) error {
	return d.update(ctx, "SetClientDataLimit", remoteID, func(c *wireClient) { c.TotalGB = ceiling(ceilingBytes) })
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
// the subset. An empty set is not read.
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

// usage reads each client's counters row. A client with none has served
// nothing yet and is not reported.
func (d *Driver) usage(ctx context.Context, op string, want map[string]bool) ([]driver.ClientUsage, error) {
	list, at, err := d.list(ctx, op)
	if err != nil {
		return nil, err
	}
	var out []driver.ClientUsage
	for _, r := range list {
		if r.Traffic == nil || (want != nil && !want[r.Email]) {
			continue
		}
		out = append(out, driver.ClientUsage{RemoteID: r.Email, UpBytes: r.Traffic.Up, DownBytes: r.Traffic.Down, ObservedAt: at})
	}
	return out, nil
}

// ResetUsage zeroes the client's counters. The panel refuses an email it does
// not hold, so no read comes first.
func (d *Driver) ResetUsage(ctx context.Context, remoteID string) error {
	return d.call(ctx, "ResetUsage", http.MethodPost, []string{"panel", "api", "clients", "resetTraffic", remoteID}, nil, nil)
}

// BuildLink: the subscription is the link, as on `sanaee` — a link assembled
// here would be a second implementation of the panel's and would disagree
// with it.
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
	r, ok, err := d.find(ctx, op, remoteID)
	if err != nil || !ok {
		return "", false
	}
	u, ok, err := d.subscription(ctx, op, r.SubID)
	return u, ok && err == nil
}

// ClientLinks is every line the panel's subscription server gives the client,
// read from the address SubscriptionURL builds, with no session of ours
// (contract.links.md). A client with no subId, or a panel with the sub server
// off, has none to give.
func (d *Driver) ClientLinks(ctx context.Context, client driver.RemoteClient) ([]string, error) {
	const op = "ClientLinks"
	r, err := d.mustFind(ctx, op, client.RemoteID)
	if err != nil {
		return nil, err
	}
	u, ok, err := d.subscription(ctx, op, r.SubID)
	if err != nil || !ok {
		return nil, err
	}
	return driver.FetchLinks(ctx, d.http, op, u)
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
	if err := d.call(ctx, op, http.MethodPost, []string{"panel", "api", "setting", "all"}, nil, &s); err != nil {
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
