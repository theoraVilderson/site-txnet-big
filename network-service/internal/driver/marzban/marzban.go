// Package marzban is the driver for Marzban panels (F-027-ae): the first real
// family, chosen because it is the simplest — pull, cumulative — and one that
// enforces a per-user data limit itself, so it carries ADR-0072 end to end.
//
// Marzban speaks REST behind a bearer token. A user is keyed by its username,
// which Marzban never renames; the byte figure is one `used_traffic` total with
// no up/down split, reported in DownBytes as driver.ClientUsage asks; and the
// data limit is enforced against that same total.
//
// Two of the family's defaults are the opposite of ours, and the driver holds
// both at the wire so nothing above it has to know:
//
//   - a `data_limit` of 0 is unlimited on Marzban, and a ceiling of zero is a
//     cut-off here (driver.Driver.SetClientDataLimit). Zero is written as one
//     byte, the smallest ceiling Marzban enforces.
//   - a `data_limit_reset_strategy` other than `no_reset` zeroes the counter on
//     Marzban's own schedule. Every write sets `no_reset`, so we stay the only
//     writer of the quota.
package marzban

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
	"sync"
	"time"

	"network-service/internal/driver"
)

// Credentials is a Marzban admin login. How it is read out of the owner's
// vault is F-027-aw's; this package only uses it.
type Credentials struct {
	Username string
	Password string
}

// Driver is one Marzban panel. It is safe for concurrent use; driver.Pace is
// what keeps concurrent use from becoming a flood.
type Driver struct {
	base  *url.URL
	creds Credentials
	http  *http.Client

	mu    sync.Mutex
	token string
}

var _ driver.Driver = (*Driver)(nil)

// protocols are the Marzban proxy types this driver provisions, in the order a
// client carrying several is read by. Their names are `network.ConfigProtocol`'s
// already, so no spelling is translated.
var protocols = []string{"vless", "vmess", "trojan", "shadowsocks"}

// noReset is the only reset strategy we write (package doc).
const noReset = "no_reset"

// New builds a driver over the panel at baseURL. Nothing is sent until the
// first call; the login is made then, and again once whenever the token has
// expired.
func New(baseURL string, creds Credentials, client *http.Client) (*Driver, error) {
	base, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("marzban: base url %q is not an absolute url", baseURL)
	}
	if client == nil {
		// No client timeout: the caller's context is the deadline (driver.Driver).
		client = &http.Client{}
	}
	return &Driver{base: base, creds: creds, http: client}, nil
}

// ---- wire ------------------------------------------------------------------

type proxy struct {
	ID       string `json:"id,omitempty"`
	Password string `json:"password,omitempty"`
}

// userBody is both UserCreate and UserModify. Marzban's modify changes only
// the fields present, so every field is omitted unless set.
type userBody struct {
	Username               string              `json:"username,omitempty"`
	Proxies                map[string]proxy    `json:"proxies,omitempty"`
	Inbounds               map[string][]string `json:"inbounds,omitempty"`
	DataLimit              *int64              `json:"data_limit,omitempty"`
	Expire                 *int64              `json:"expire,omitempty"`
	Note                   *string             `json:"note,omitempty"`
	Status                 string              `json:"status,omitempty"`
	DataLimitResetStrategy string              `json:"data_limit_reset_strategy,omitempty"`
}

type user struct {
	Username        string              `json:"username"`
	Status          string              `json:"status"`
	UsedTraffic     int64               `json:"used_traffic"`
	DataLimit       *int64              `json:"data_limit"`
	Expire          *int64              `json:"expire"`
	Note            *string             `json:"note"`
	Proxies         map[string]proxy    `json:"proxies"`
	Inbounds        map[string][]string `json:"inbounds"`
	SubscriptionURL string              `json:"subscription_url"`
	Links           []string            `json:"links"`
}

type userList struct {
	Users []user `json:"users"`
}

type inbound struct {
	Tag      string `json:"tag"`
	Protocol string `json:"protocol"`
	Port     int    `json:"port"`
}

// protocol is the proxy this client is read by, and its identity.
func (u user) protocol() (string, string) {
	for _, p := range protocols {
		if px, ok := u.Proxies[p]; ok {
			return p, px.ID + px.Password
		}
	}
	return "", ""
}

func (u user) remote() driver.RemoteClient {
	proto, id := u.protocol()
	c := driver.RemoteClient{
		RemoteID: u.Username,
		UUID:     id,
		Enabled:  u.Status != "disabled",
	}
	if tags := u.Inbounds[proto]; len(tags) > 0 {
		c.InboundRemoteID = tags[0]
	}
	if u.Note != nil {
		c.Label = *u.Note
	}
	if u.DataLimit != nil {
		c.DataLimitBytes = *u.DataLimit
	}
	if u.Expire != nil && *u.Expire > 0 {
		c.ExpiresAt = time.Unix(*u.Expire, 0).UTC()
	}
	return c
}

// ceiling is a ceiling as Marzban must be told it: never 0, which it reads as
// unlimited (package doc).
func ceiling(bytes int64) *int64 {
	if bytes < 1 {
		bytes = 1
	}
	return &bytes
}

// limitOf is the figure a create or an update writes: Marzban's own 0 for a
// client wanted with no limit (F-111-r), a ceiling otherwise.
func limitOf(none bool, bytes int64) *int64 {
	if none {
		var zero int64
		return &zero
	}
	return ceiling(bytes)
}

func expiry(at time.Time) *int64 {
	var s int64
	if !at.IsZero() {
		s = at.Unix()
	}
	return &s
}

func status(enabled bool) string {
	if enabled {
		return "active"
	}
	return "disabled"
}

func credential(protocol, id string) proxy {
	if protocol == "trojan" || protocol == "shadowsocks" {
		return proxy{Password: id}
	}
	return proxy{ID: id}
}

// ---- transport -------------------------------------------------------------

// call sends one request with the current token. A 401 is an expired token
// on Marzban, so it is answered by one login and one retry; a login refused
// is a blocked fault and is not retried (contract.budget.md).
func (d *Driver) call(ctx context.Context, op, method string, path []string, query url.Values, body, out any) error {
	token, err := d.currentToken(ctx, op)
	if err != nil {
		return err
	}
	err = d.do(ctx, op, method, path, query, body, out, token)
	var fault *driver.Fault
	if !errors.As(err, &fault) || fault.Status != http.StatusUnauthorized {
		return err
	}
	if token, err = d.login(ctx, op); err != nil {
		return err
	}
	return d.do(ctx, op, method, path, query, body, out, token)
}

func (d *Driver) currentToken(ctx context.Context, op string) (string, error) {
	d.mu.Lock()
	token := d.token
	d.mu.Unlock()
	if token != "" {
		return token, nil
	}
	return d.login(ctx, op)
}

func (d *Driver) login(ctx context.Context, op string) (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	form := url.Values{"username": {d.creds.Username}, "password": {d.creds.Password}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.base.JoinPath("api", "admin", "token").String(),
		strings.NewReader(form.Encode()))
	if err != nil {
		return "", driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := d.send(ctx, op, req, &out); err != nil {
		d.token = ""
		return "", err
	}
	if out.AccessToken == "" {
		return "", driver.NewFault(driver.FaultProtocol, op, 0, errors.New("login answered no access_token"))
	}
	d.token = out.AccessToken
	return d.token, nil
}

func (d *Driver) do(ctx context.Context, op, method string, path []string, query url.Values, body, out any, token string) error {
	u := d.base.JoinPath(path...)
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
	req.Header.Set("Authorization", "Bearer "+token)
	return d.send(ctx, op, req, out)
}

// send is where every failure is classified (driver.Fault). Nothing above the
// driver reads a status code.
func (d *Driver) send(ctx context.Context, op string, req *http.Request, out any) error {
	resp, err := d.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return driver.NewFault(driver.FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, err))
		}
		return driver.NewFault(driver.FaultUnavailable, op, 0, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		fault := driver.FaultForStatus(op, resp.StatusCode, fmt.Errorf("%s", strings.TrimSpace(string(detail))))
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

func (d *Driver) getUser(ctx context.Context, op, remoteID string) (user, error) {
	var u user
	err := d.call(ctx, op, http.MethodGet, []string{"api", "user", remoteID}, nil, nil, &u)
	return u, err
}

func (d *Driver) modify(ctx context.Context, op, remoteID string, body userBody) (user, error) {
	var u user
	err := d.call(ctx, op, http.MethodPut, []string{"api", "user", remoteID}, nil, body, &u)
	return u, err
}

// ---- the driver ------------------------------------------------------------

// Capabilities proves the login, then answers for the family. Every answer is
// Marzban's API rather than a setting of this panel: the one per-panel choice
// that could change a row, the reset strategy, is written by us on every write.
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
			driver.RowPerClientUsage:          yes("used_traffic per user, one total with no up/down split"),
			driver.RowBulkUsageInOneCall:      yes("GET /api/users with no limit returns every user"),
			driver.RowUsageForNamedSubset:     yes("GET /api/users?username=… filters to the named users in one call"),
			driver.RowUsageResetSupported:     yes("POST /api/user/{username}/reset"),
			driver.RowCounterSurvivesUpdate:   yes("PUT /api/user/{username} leaves used_traffic as it was"),
			driver.RowPerClientDataLimit:      yes("data_limit, enforced by Marzban itself; zero is written as one byte, since 0 is unlimited there"),
			driver.RowDataLimitCountsSameByte: yes("data_limit is checked against used_traffic, the figure we read"),
			driver.RowPerClientRateLimit:      no("Marzban has no per-user bandwidth cap"),
			driver.RowEnableDisableClient:     yes("status active / disabled"),
			driver.RowClientLifecycle:         yes("POST, PUT and DELETE /api/user"),
			driver.RowStableRemoteID:          yes("the username, which Marzban cannot rename"),
			driver.RowClientLabelStorable:     yes("the note field"),
			driver.RowNativeSubscriptionLink:  yes("subscription_url"),
			driver.RowServerSideExpiry:        yes("expire, enforced by Marzban itself"),
			driver.RowInternalCreditDisabled:  yes("no credit of its own; data_limit_reset_strategy is written no_reset on every write"),
		},
	}, nil
}

// HealthCheck reads the logged-in admin: the cheapest call that needs a valid
// token.
func (d *Driver) HealthCheck(ctx context.Context) error {
	return d.call(ctx, "HealthCheck", http.MethodGet, []string{"api", "admin"}, nil, nil, nil)
}

func (d *Driver) ListInbounds(ctx context.Context) ([]driver.Inbound, error) {
	var byProtocol map[string][]inbound
	if err := d.call(ctx, "ListInbounds", http.MethodGet, []string{"api", "inbounds"}, nil, nil, &byProtocol); err != nil {
		return nil, err
	}
	var out []driver.Inbound
	for proto, list := range byProtocol {
		for _, in := range list {
			out = append(out, driver.Inbound{RemoteID: in.Tag, Tag: in.Tag, Protocol: proto, Port: in.Port, Enabled: true})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Tag < out[j].Tag })
	return out, nil
}

func (d *Driver) listUsers(ctx context.Context, op string, names []string) ([]user, time.Time, error) {
	var query url.Values
	if len(names) > 0 {
		query = url.Values{"username": names}
	}
	var list userList
	if err := d.call(ctx, op, http.MethodGet, []string{"api", "users"}, query, nil, &list); err != nil {
		return nil, time.Time{}, err
	}
	return list.Users, time.Now(), nil
}

// ListClients reads the panel, never our last write: the limit reported is
// the one Marzban holds now.
func (d *Driver) ListClients(ctx context.Context) ([]driver.RemoteClient, error) {
	users, _, err := d.listUsers(ctx, "ListClients", nil)
	if err != nil {
		return nil, err
	}
	out := make([]driver.RemoteClient, 0, len(users))
	for _, u := range users {
		out = append(out, u.remote())
	}
	return out, nil
}

// CreateClient names the user after its uuid without hyphens — 32 characters,
// inside Marzban's username rule, and fixed for the client's life because a
// username cannot change. Marzban creates only active users, so a client
// wanted disabled is disabled by a second request.
func (d *Driver) CreateClient(ctx context.Context, req driver.CreateClientRequest) (driver.RemoteClient, error) {
	const op = "CreateClient"
	if !isProtocol(req.Protocol) {
		return driver.RemoteClient{}, driver.NewFault(driver.FaultUnsupported, op, 0,
			fmt.Errorf("marzban has no %q proxy", req.Protocol))
	}
	username := strings.ReplaceAll(req.UUID, "-", "")
	if len(username) < 3 || len(username) > 32 {
		return driver.RemoteClient{}, driver.NewFault(driver.FaultProtocol, op, 0,
			fmt.Errorf("uuid %q does not make a 3-32 character username", req.UUID))
	}
	note := req.ClaimTag
	body := userBody{
		Username:               username,
		Proxies:                map[string]proxy{req.Protocol: credential(req.Protocol, req.UUID)},
		Inbounds:               map[string][]string{req.Protocol: {req.InboundRemoteID}},
		DataLimit:              limitOf(req.NoDataLimit, req.DataLimitBytes),
		Expire:                 expiry(req.ExpiresAt),
		Note:                   &note,
		Status:                 "active",
		DataLimitResetStrategy: noReset,
	}
	var created user
	if err := d.call(ctx, op, http.MethodPost, []string{"api", "user"}, nil, body, &created); err != nil {
		return driver.RemoteClient{}, err
	}
	if !req.Enabled {
		disabled, err := d.modify(ctx, op, created.Username, userBody{Status: status(false)})
		if err != nil {
			return created.remote(), err
		}
		created = disabled
	}
	return created.remote(), nil
}

// UpdateClient writes the whole client as it should now be. The request does
// not carry the protocol, so the user is read first and keeps the proxy type
// it has.
func (d *Driver) UpdateClient(ctx context.Context, req driver.UpdateClientRequest) error {
	const op = "UpdateClient"
	current, err := d.getUser(ctx, op, req.RemoteID)
	if err != nil {
		return err
	}
	proto, _ := current.protocol()
	if proto == "" {
		return driver.NewFault(driver.FaultUnsupported, op, 0,
			fmt.Errorf("user %q carries no proxy this driver provisions", req.RemoteID))
	}
	note := req.ClaimTag
	body := userBody{
		Proxies:                map[string]proxy{proto: credential(proto, req.UUID)},
		DataLimit:              limitOf(req.NoDataLimit, req.DataLimitBytes),
		Expire:                 expiry(req.ExpiresAt),
		Note:                   &note,
		Status:                 status(req.Enabled),
		DataLimitResetStrategy: noReset,
	}
	if req.InboundRemoteID != "" {
		body.Inbounds = map[string][]string{proto: {req.InboundRemoteID}}
	}
	_, err = d.modify(ctx, op, req.RemoteID, body)
	return err
}

func (d *Driver) SetClientEnabled(ctx context.Context, remoteID string, enabled bool) error {
	_, err := d.modify(ctx, "SetClientEnabled", remoteID, userBody{Status: status(enabled)})
	return err
}

func (d *Driver) DeleteClient(ctx context.Context, remoteID string) error {
	return d.call(ctx, "DeleteClient", http.MethodDelete, []string{"api", "user", remoteID}, nil, nil, nil)
}

// SetClientDataLimit writes the ceiling Marzban enforces. Raising it above
// used_traffic is also what reactivates a user Marzban marked `limited`.
func (d *Driver) SetClientDataLimit(ctx context.Context, remoteID string, ceilingBytes int64) error {
	_, err := d.modify(ctx, "SetClientDataLimit", remoteID,
		userBody{DataLimit: ceiling(ceilingBytes), DataLimitResetStrategy: noReset})
	return err
}

// SetClientRateLimit: Marzban has no per-user bandwidth cap. "No cap" is
// already true, and anything else is refused rather than believed.
func (d *Driver) SetClientRateLimit(_ context.Context, _ string, rateBps int64) error {
	if rateBps <= 0 {
		return nil
	}
	return driver.NewFault(driver.FaultUnsupported, "SetClientRateLimit", 0, errors.New("marzban has no per-user rate limit"))
}

func (d *Driver) GetUsage(ctx context.Context) ([]driver.ClientUsage, error) {
	return d.usage(ctx, "GetUsage", nil)
}

// GetUsageFor reads the named users in one request. An empty set is not read.
func (d *Driver) GetUsageFor(ctx context.Context, remoteIDs []string) ([]driver.ClientUsage, error) {
	if len(remoteIDs) == 0 {
		return nil, nil
	}
	return d.usage(ctx, "GetUsageFor", remoteIDs)
}

func (d *Driver) usage(ctx context.Context, op string, names []string) ([]driver.ClientUsage, error) {
	users, at, err := d.listUsers(ctx, op, names)
	if err != nil {
		return nil, err
	}
	out := make([]driver.ClientUsage, 0, len(users))
	for _, u := range users {
		out = append(out, driver.ClientUsage{RemoteID: u.Username, DownBytes: u.UsedTraffic, ObservedAt: at})
	}
	return out, nil
}

func (d *Driver) ResetUsage(ctx context.Context, remoteID string) error {
	return d.call(ctx, "ResetUsage", http.MethodPost, []string{"api", "user", remoteID, "reset"}, nil, nil, nil)
}

// BuildLink returns the link Marzban built for this client on the inbound's
// protocol. Marzban builds links itself, from its host settings, and a link
// assembled here would disagree with the one it serves.
func (d *Driver) BuildLink(ctx context.Context, client driver.RemoteClient, in driver.Inbound) (string, error) {
	const op = "BuildLink"
	u, err := d.getUser(ctx, op, client.RemoteID)
	if err != nil {
		return "", err
	}
	scheme := in.Protocol
	if scheme == "shadowsocks" {
		scheme = "ss"
	}
	for _, link := range u.Links {
		if strings.HasPrefix(link, scheme+"://") {
			return link, nil
		}
	}
	return "", driver.NewFault(driver.FaultProtocol, op, 0,
		fmt.Errorf("user %q has no %s link", client.RemoteID, in.Protocol))
}

// SubscriptionURL resolves Marzban's subscription_url, which is a path unless
// the panel has XRAY_SUBSCRIPTION_URL_PREFIX set. The interface has no error:
// a failed read answers false, and the caller falls back to BuildLink.
func (d *Driver) SubscriptionURL(ctx context.Context, remoteID string) (string, bool) {
	u, err := d.getUser(ctx, "SubscriptionURL", remoteID)
	if err != nil || u.SubscriptionURL == "" {
		return "", false
	}
	ref, err := url.Parse(u.SubscriptionURL)
	if err != nil {
		return "", false
	}
	return d.base.ResolveReference(ref).String(), true
}

// ClientLinks is every link Marzban built for the user, its `links` field:
// rule 6, for every protocol at once (contract.links.md).
func (d *Driver) ClientLinks(ctx context.Context, client driver.RemoteClient) ([]string, error) {
	u, err := d.getUser(ctx, "ClientLinks", client.RemoteID)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, link := range u.Links {
		if link = strings.TrimSpace(link); link != "" {
			out = append(out, link)
		}
	}
	return out, nil
}

func isProtocol(p string) bool {
	for _, known := range protocols {
		if p == known {
			return true
		}
	}
	return false
}
