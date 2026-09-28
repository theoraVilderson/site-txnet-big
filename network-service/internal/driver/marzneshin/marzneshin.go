// Package marzneshin is the driver for Marzneshin panels (F-027-ba). It is
// Marzban's successor, not Marzban: the routes, the user model and the paging
// all differ, so it is a family and a package of its own.
//
// Marzneshin speaks REST behind a bearer token. A user is keyed by its
// username, which it never renames; the byte figure is one `used_traffic`
// total with no up/down split, reported in DownBytes as driver.ClientUsage
// asks; and the data limit is enforced against that same total, so the family
// carries ADR-0072 as Marzban does.
//
// Four of the family's shapes are held at the wire so nothing above the driver
// has to know them:
//
//   - `GET /api/users` is paged by fastapi-pagination at 100 at most, with no
//     unpaged read. The bulk pass reads pages of 100 and pays for every page
//     after the first through driver.NextPage (ADR-0081).
//   - one `username` filter is a substring search (`ilike %x%`) and two or
//     more are exact (`IN`). A single name is sent twice, and every answer is
//     filtered to the names asked for.
//   - a `data_limit` of 0 is stored as no limit, and a ceiling of zero is a
//     cut-off here (driver.Driver.SetClientDataLimit). Zero is written as one
//     byte.
//   - the `key` is the user's credential and no PUT can change it. A
//     regenerate deletes the user and creates it again under the same
//     username with the new key (user, 2026-09-24); Marzneshin's delete is
//     soft and frees the username.
//
// A user reaches inbounds through services, not directly. An Inbound here is
// one service for one protocol it serves, so provisioning's lookup by protocol
// finds the service a config is created under.
package marzneshin

import (
	"bufio"
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

// Credentials is a Marzneshin admin login. How it is read out of the owner's
// vault is F-027-aw's; this package only uses it.
type Credentials struct {
	Username string
	Password string
}

// Driver is one Marzneshin panel. It is safe for concurrent use; driver.Pace
// is what keeps concurrent use from becoming a flood.
type Driver struct {
	base *url.URL
	// client is where users are served (F-027-bg). A relative
	// subscription_url is resolved against it, and against base without one.
	client *url.URL
	creds  Credentials
	http   *http.Client

	mu    sync.Mutex
	token string
}

var _ driver.Driver = (*Driver)(nil)

// protocols are the Marzneshin proxy types we sell. Their names are
// `network.ConfigProtocol`'s already; shadowsocks2022, shadowtls and the rest
// have no config protocol and are not offered.
var protocols = []string{"vless", "vmess", "trojan", "shadowsocks", "hysteria2", "tuic", "wireguard"}

// schemes are the link schemes a protocol's line may start with, where they
// are not the protocol's own name.
var schemes = map[string][]string{
	"shadowsocks": {"ss"},
	"hysteria2":   {"hysteria2", "hy2"},
}

// noReset is the only reset strategy we write (package doc).
const noReset = "no_reset"

// dateLayout is Marzneshin's expire_date: a naive datetime, read as UTC.
const dateLayout = "2006-01-02T15:04:05"

// New builds a driver over the panel at baseURL. clientBaseURL is optional.
// Nothing is sent until the first call; the login is made then, and again once
// whenever the token has expired.
func New(baseURL, clientBaseURL string, creds Credentials, client *http.Client) (*Driver, error) {
	base, err := absolute(baseURL)
	if err != nil {
		return nil, fmt.Errorf("marzneshin: base url %q is not an absolute url", baseURL)
	}
	d := &Driver{base: base, client: base, creds: creds, http: client}
	if strings.TrimSpace(clientBaseURL) != "" {
		if d.client, err = absolute(clientBaseURL); err != nil {
			return nil, fmt.Errorf("marzneshin: client base url %q is not an absolute url", clientBaseURL)
		}
	}
	if d.http == nil {
		// No client timeout: the caller's context is the deadline (driver.Driver).
		d.http = &http.Client{}
	}
	return d, nil
}

func absolute(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, errors.New("not absolute")
	}
	return u, nil
}

// ---- wire ------------------------------------------------------------------

// userBody is UserCreate and UserModify. A modify changes only the fields
// that are present and not null, but it requires the username.
type userBody struct {
	Username               string  `json:"username"`
	Key                    string  `json:"key,omitempty"`
	ServiceIDs             []int   `json:"service_ids,omitempty"`
	DataLimit              *int64  `json:"data_limit,omitempty"`
	DataLimitResetStrategy string  `json:"data_limit_reset_strategy,omitempty"`
	ExpireStrategy         string  `json:"expire_strategy,omitempty"`
	ExpireDate             *string `json:"expire_date,omitempty"`
	Note                   *string `json:"note,omitempty"`
}

type user struct {
	Username        string  `json:"username"`
	Key             string  `json:"key"`
	Enabled         bool    `json:"enabled"`
	UsedTraffic     int64   `json:"used_traffic"`
	DataLimit       *int64  `json:"data_limit"`
	ExpireStrategy  string  `json:"expire_strategy"`
	ExpireDate      *string `json:"expire_date"`
	Note            *string `json:"note"`
	ServiceIDs      []int   `json:"service_ids"`
	SubscriptionURL string  `json:"subscription_url"`
}

type inbound struct {
	Tag        string `json:"tag"`
	Protocol   string `json:"protocol"`
	ServiceIDs []int  `json:"service_ids"`
}

// page is fastapi-pagination's Page.
type page[T any] struct {
	Items []T `json:"items"`
	Pages int `json:"pages"`
}

func (u user) remote() driver.RemoteClient {
	c := driver.RemoteClient{
		RemoteID: u.Username,
		UUID:     uuidOf(u.Key),
		Enabled:  u.Enabled,
	}
	if len(u.ServiceIDs) > 0 {
		lowest := u.ServiceIDs[0]
		for _, id := range u.ServiceIDs {
			lowest = min(lowest, id)
		}
		c.InboundRemoteID = strconv.Itoa(lowest)
	}
	if u.Note != nil {
		c.Label = *u.Note
	}
	if u.DataLimit != nil {
		c.DataLimitBytes = *u.DataLimit
	}
	if u.ExpireStrategy == "fixed_date" && u.ExpireDate != nil {
		c.ExpiresAt = parseDate(*u.ExpireDate)
	}
	return c
}

// keyOf is the key a config's uuid is written as: its 32 hex digits, the shape
// of the key Marzneshin generates itself.
func keyOf(uuid string) string { return strings.ToLower(strings.ReplaceAll(uuid, "-", "")) }

// uuidOf reads a key back as the uuid it was written from. A key we did not
// write is returned as it is, and matches no config by uuid.
func uuidOf(key string) string {
	if len(key) != 32 {
		return key
	}
	return key[0:8] + "-" + key[8:12] + "-" + key[12:16] + "-" + key[16:20] + "-" + key[20:32]
}

func parseDate(raw string) time.Time {
	for _, layout := range []string{time.RFC3339Nano, dateLayout, dateLayout + ".999999"} {
		if at, err := time.Parse(layout, raw); err == nil {
			return at.UTC()
		}
	}
	return time.Time{}
}

// ceiling is a ceiling as Marzneshin must be told it: never 0, which it
// stores as no limit (package doc).
func ceiling(bytes int64) *int64 {
	if bytes < 1 {
		bytes = 1
	}
	return &bytes
}

// limitOf is the figure a create or an update writes: Marzneshin's own 0 for a
// client wanted with no limit (F-111-r), a ceiling otherwise.
func limitOf(none bool, bytes int64) *int64 {
	if none {
		var zero int64
		return &zero
	}
	return ceiling(bytes)
}

// withExpiry sets the expiry fields: `never` clears the date, and a date is
// only kept under `fixed_date`.
func (b *userBody) withExpiry(at time.Time) {
	if at.IsZero() {
		b.ExpireStrategy = "never"
		return
	}
	date := at.UTC().Format(dateLayout)
	b.ExpireStrategy, b.ExpireDate = "fixed_date", &date
}

func serviceID(op, raw string) (int, error) {
	id, err := strconv.Atoi(raw)
	if err != nil || id < 1 {
		return 0, driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("inbound %q is not a Marzneshin service id", raw))
	}
	return id, nil
}

// ---- transport -------------------------------------------------------------

// call sends one request with the current token. A 401 is an expired token,
// so it is answered by one login and one retry; a login refused is a blocked
// fault and is not retried (contract.budget.md).
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
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.base.JoinPath("api", "admins", "token").String(),
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
// driver reads a status code. out is decoded as JSON, or filled whole when it
// is a *[]byte.
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
	var decodeErr error
	switch out := out.(type) {
	case nil:
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	case *[]byte:
		*out, decodeErr = io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	default:
		decodeErr = json.NewDecoder(resp.Body).Decode(out)
	}
	if decodeErr != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return driver.NewFault(driver.FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, decodeErr))
		}
		return driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("decoding the answer: %w", decodeErr))
	}
	return nil
}

func isStatus(err error, status int) bool {
	var fault *driver.Fault
	return errors.As(err, &fault) && fault.Status == status
}

func (d *Driver) getUser(ctx context.Context, op, remoteID string) (user, error) {
	var u user
	err := d.call(ctx, op, http.MethodGet, []string{"api", "users", remoteID}, nil, nil, &u)
	return u, err
}

func (d *Driver) modify(ctx context.Context, op string, body userBody) error {
	return d.call(ctx, op, http.MethodPut, []string{"api", "users", body.Username}, nil, body, nil)
}

// setEnabled is its own route on Marzneshin, and answers 409 when the user is
// already in that state — which is the state asked for, so it is done.
func (d *Driver) setEnabled(ctx context.Context, op, remoteID string, enabled bool) error {
	action := "disable"
	if enabled {
		action = "enable"
	}
	err := d.call(ctx, op, http.MethodPost, []string{"api", "users", remoteID, action}, nil, nil, nil)
	if isStatus(err, http.StatusConflict) {
		return nil
	}
	return err
}

// paged reads every page of a listing at driver.MinPageSize. The first page
// is the call's own request; every later one is paid for first (ADR-0081). It
// stops at the last page the panel names, so it never asks for an empty one.
func paged[T any](ctx context.Context, d *Driver, op string, path []string, query url.Values, each func(T, time.Time)) error {
	for n := 1; ; n++ {
		if n > 1 {
			if err := driver.NextPage(ctx, op); err != nil {
				return err
			}
		}
		q := url.Values{}
		for k, v := range query {
			q[k] = v
		}
		q.Set("page", strconv.Itoa(n))
		q.Set("size", strconv.Itoa(driver.MinPageSize))
		var p page[T]
		if err := d.call(ctx, op, http.MethodGet, path, q, nil, &p); err != nil {
			return err
		}
		at := time.Now()
		for _, item := range p.Items {
			each(item, at)
		}
		if len(p.Items) == 0 || n >= p.Pages {
			return nil
		}
	}
}

// users reads every user, or only the named ones. created_at order keeps a
// user made during the pass off the pages already read; a user seen twice is
// kept once.
func (d *Driver) users(ctx context.Context, op string, names []string) ([]user, []time.Time, error) {
	var out []user
	var at []time.Time
	seen := map[string]bool{}
	keep := func(u user, when time.Time) {
		if !seen[u.Username] {
			seen[u.Username] = true
			out, at = append(out, u), append(at, when)
		}
	}
	if names == nil {
		err := paged(ctx, d, op, []string{"api", "users"}, url.Values{"order_by": {"created_at"}}, keep)
		return out, at, err
	}
	want := map[string]bool{}
	var unique []string
	for _, n := range names {
		if !want[n] {
			want[n] = true
			unique = append(unique, n)
		}
	}
	for from := 0; from < len(unique); from += driver.MinPageSize {
		if from > 0 {
			if err := driver.NextPage(ctx, op); err != nil {
				return nil, nil, err
			}
		}
		chunk := unique[from:min(from+driver.MinPageSize, len(unique))]
		if len(chunk) == 1 {
			// One name is `ilike %x%`; two are `IN` (package doc).
			chunk = []string{chunk[0], chunk[0]}
		}
		var p page[user]
		q := url.Values{"username": chunk, "page": {"1"}, "size": {strconv.Itoa(driver.MinPageSize)}}
		if err := d.call(ctx, op, http.MethodGet, []string{"api", "users"}, q, nil, &p); err != nil {
			return nil, nil, err
		}
		now := time.Now()
		for _, u := range p.Items {
			if want[u.Username] {
				keep(u, now)
			}
		}
	}
	return out, at, nil
}

// ---- the driver ------------------------------------------------------------

// Capabilities proves the login, then answers for the family. Every answer is
// Marzneshin's API rather than a setting of this panel: the one per-panel
// choice that could change a row, the reset strategy, is written by us on
// every write.
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
			driver.RowBulkUsageInOneCall:      yes("GET /api/users, paged at 100 users a page (ADR-0081)"),
			driver.RowUsageForNamedSubset:     yes("GET /api/users?username=…&username=… is an exact match for two or more names; one name is sent twice"),
			driver.RowUsageResetSupported:     yes("POST /api/users/{username}/reset"),
			driver.RowCounterSurvivesUpdate:   yes("PUT /api/users/{username} leaves used_traffic as it was; only a regenerate, which recreates the user, starts it again"),
			driver.RowPerClientDataLimit:      yes("data_limit, enforced by Marzneshin itself; zero is written as one byte, since 0 is no limit there"),
			driver.RowDataLimitCountsSameByte: yes("data_limit is checked against used_traffic, the figure we read"),
			driver.RowPerClientRateLimit:      no("Marzneshin has no per-user bandwidth cap"),
			driver.RowPerClientIPLimit:        no("Marzneshin has no per-user address limit"),
			driver.RowEnableDisableClient:     yes("POST /api/users/{username}/enable and /disable"),
			driver.RowClientLifecycle:         yes("POST, PUT and DELETE /api/users"),
			driver.RowStableRemoteID:          yes("the username, which no Marzneshin route renames"),
			driver.RowClientLabelStorable:     yes("the note field"),
			driver.RowNativeSubscriptionLink:  yes("subscription_url, /sub/{username}/{key}"),
			driver.RowServerSideExpiry:        yes("expire_strategy fixed_date with expire_date, enforced by Marzneshin itself"),
			driver.RowInternalCreditDisabled:  yes("no credit of its own; data_limit_reset_strategy is written no_reset on every write"),
		},
	}, nil
}

// HealthCheck reads the logged-in admin: the cheapest call that needs a valid
// token.
func (d *Driver) HealthCheck(ctx context.Context) error {
	return d.call(ctx, "HealthCheck", http.MethodGet, []string{"api", "admins", "current"}, nil, nil, nil)
}

// ListInbounds answers one Inbound per service and protocol it serves: the
// service is what a user is attached to (package doc). The tag is the first
// inbound's that brought the pair in.
func (d *Driver) ListInbounds(ctx context.Context) ([]driver.Inbound, error) {
	seen := map[[2]string]bool{}
	var out []driver.Inbound
	err := paged(ctx, d, "ListInbounds", []string{"api", "inbounds"}, nil, func(in inbound, _ time.Time) {
		if !isProtocol(in.Protocol) {
			return
		}
		for _, id := range in.ServiceIDs {
			key := [2]string{strconv.Itoa(id), in.Protocol}
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, driver.Inbound{RemoteID: key[0], Tag: in.Tag, Protocol: in.Protocol, Enabled: true})
		}
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool {
		a, _ := strconv.Atoi(out[i].RemoteID)
		b, _ := strconv.Atoi(out[j].RemoteID)
		if a != b {
			return a < b
		}
		return out[i].Protocol < out[j].Protocol
	})
	return out, nil
}

// ListClients reads the panel, never our last write: the limit reported is
// the one Marzneshin holds now.
func (d *Driver) ListClients(ctx context.Context) ([]driver.RemoteClient, error) {
	users, _, err := d.users(ctx, "ListClients", nil)
	if err != nil {
		return nil, err
	}
	out := make([]driver.RemoteClient, 0, len(users))
	for _, u := range users {
		out = append(out, u.remote())
	}
	return out, nil
}

// CreateClient names the user after its uuid without hyphens, and writes the
// same 32 characters as its key. Marzneshin creates only enabled users, so a
// client wanted disabled is disabled by a second request.
func (d *Driver) CreateClient(ctx context.Context, req driver.CreateClientRequest) (driver.RemoteClient, error) {
	const op = "CreateClient"
	if !isProtocol(req.Protocol) {
		return driver.RemoteClient{}, driver.NewFault(driver.FaultUnsupported, op, 0,
			fmt.Errorf("marzneshin has no %q proxy we sell", req.Protocol))
	}
	return d.create(ctx, op, keyOf(req.UUID), req.UUID, req.InboundRemoteID, nil, req.ClaimTag,
		limitOf(req.NoDataLimit, req.DataLimitBytes), req.ExpiresAt, req.Enabled)
}

func (d *Driver) create(ctx context.Context, op, username, uuid, inboundID string, services []int,
	claimTag string, limit *int64, expires time.Time, enabled bool) (driver.RemoteClient, error) {
	if len(username) < 3 || len(username) > 32 {
		return driver.RemoteClient{}, driver.NewFault(driver.FaultProtocol, op, 0,
			fmt.Errorf("%q does not make a 3-32 character username", username))
	}
	if inboundID != "" {
		id, err := serviceID(op, inboundID)
		if err != nil {
			return driver.RemoteClient{}, err
		}
		services = []int{id}
	}
	note := claimTag
	body := userBody{
		Username: username, Key: keyOf(uuid), ServiceIDs: services,
		DataLimit: limit, DataLimitResetStrategy: noReset, Note: &note,
	}
	body.withExpiry(expires)
	var created user
	if err := d.call(ctx, op, http.MethodPost, []string{"api", "users"}, nil, body, &created); err != nil {
		return driver.RemoteClient{}, err
	}
	if !enabled {
		if err := d.setEnabled(ctx, op, created.Username, false); err != nil {
			return created.remote(), err
		}
		created.Enabled = false
	}
	return created.remote(), nil
}

// UpdateClient writes the whole client as it should now be. The user is read
// first, because a new uuid cannot be written: the key is fixed, so the user
// is deleted and made again under the same username (package doc). The bytes
// served between the last read and the delete are not counted; a regenerate
// is rare and asked for by the user.
func (d *Driver) UpdateClient(ctx context.Context, req driver.UpdateClientRequest) error {
	const op = "UpdateClient"
	current, err := d.getUser(ctx, op, req.RemoteID)
	if err != nil {
		return err
	}
	if current.Key != keyOf(req.UUID) {
		if err := d.DeleteClient(ctx, req.RemoteID); err != nil {
			return err
		}
		_, err := d.create(ctx, op, req.RemoteID, req.UUID, req.InboundRemoteID, current.ServiceIDs,
			req.ClaimTag, limitOf(req.NoDataLimit, req.DataLimitBytes), req.ExpiresAt, req.Enabled)
		return err
	}
	note := req.ClaimTag
	body := userBody{
		Username: req.RemoteID, DataLimit: limitOf(req.NoDataLimit, req.DataLimitBytes),
		DataLimitResetStrategy: noReset, Note: &note,
	}
	body.withExpiry(req.ExpiresAt)
	if req.InboundRemoteID != "" {
		id, err := serviceID(op, req.InboundRemoteID)
		if err != nil {
			return err
		}
		body.ServiceIDs = []int{id}
	}
	if err := d.modify(ctx, op, body); err != nil {
		return err
	}
	if current.Enabled != req.Enabled {
		return d.setEnabled(ctx, op, req.RemoteID, req.Enabled)
	}
	return nil
}

func (d *Driver) SetClientEnabled(ctx context.Context, remoteID string, enabled bool) error {
	return d.setEnabled(ctx, "SetClientEnabled", remoteID, enabled)
}

func (d *Driver) DeleteClient(ctx context.Context, remoteID string) error {
	return d.call(ctx, "DeleteClient", http.MethodDelete, []string{"api", "users", remoteID}, nil, nil, nil)
}

// SetClientDataLimit writes the ceiling Marzneshin enforces, in one request:
// a modify leaves every field it is not sent alone.
func (d *Driver) SetClientDataLimit(ctx context.Context, remoteID string, ceilingBytes int64) error {
	return d.modify(ctx, "SetClientDataLimit",
		userBody{Username: remoteID, DataLimit: ceiling(ceilingBytes), DataLimitResetStrategy: noReset})
}

// SetClientIPLimit: Marzneshin has no per-user address limit it lets us write.
// "No limit" is already true, and anything else is refused rather than believed.
func (d *Driver) SetClientIPLimit(_ context.Context, _ string, limit int) error {
	if limit <= 0 {
		return nil
	}
	return driver.NewFault(driver.FaultUnsupported, "SetClientIPLimit", 0, errors.New("Marzneshin has no per-user address limit"))
}

// SetClientRateLimit: Marzneshin has no per-user bandwidth cap. "No cap" is
// already true, and anything else is refused rather than believed.
func (d *Driver) SetClientRateLimit(_ context.Context, _ string, rateBps int64) error {
	if rateBps <= 0 {
		return nil
	}
	return driver.NewFault(driver.FaultUnsupported, "SetClientRateLimit", 0, errors.New("marzneshin has no per-user rate limit"))
}

func (d *Driver) GetUsage(ctx context.Context) ([]driver.ClientUsage, error) {
	return d.usage(ctx, "GetUsage", nil)
}

// GetUsageFor reads the named users by exact name, one request per hundred.
// An empty set is not read.
func (d *Driver) GetUsageFor(ctx context.Context, remoteIDs []string) ([]driver.ClientUsage, error) {
	if len(remoteIDs) == 0 {
		return nil, nil
	}
	return d.usage(ctx, "GetUsageFor", remoteIDs)
}

func (d *Driver) usage(ctx context.Context, op string, names []string) ([]driver.ClientUsage, error) {
	users, at, err := d.users(ctx, op, names)
	if err != nil {
		return nil, err
	}
	out := make([]driver.ClientUsage, 0, len(users))
	for i, u := range users {
		out = append(out, driver.ClientUsage{RemoteID: u.Username, DownBytes: u.UsedTraffic, ObservedAt: at[i]})
	}
	return out, nil
}

func (d *Driver) ResetUsage(ctx context.Context, remoteID string) error {
	return d.call(ctx, "ResetUsage", http.MethodPost, []string{"api", "users", remoteID, "reset"}, nil, nil, nil)
}

// BuildLink returns the line Marzneshin serves for the inbound's protocol, from
// the user's public subscription in `links` form. Marzneshin builds links from
// its host settings, and one assembled here would disagree with it. The admin
// token is never sent there: the subscription may be on another domain.
func (d *Driver) BuildLink(ctx context.Context, client driver.RemoteClient, in driver.Inbound) (string, error) {
	const op = "BuildLink"
	u, err := d.getUser(ctx, op, client.RemoteID)
	if err != nil {
		return "", err
	}
	sub, ok := d.subscription(u)
	if !ok {
		return "", driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("user %q has no subscription_url", client.RemoteID))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(sub, "/")+"/links", nil)
	if err != nil {
		return "", driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	var body []byte
	if err := d.send(ctx, op, req, &body); err != nil {
		return "", err
	}
	want := schemes[in.Protocol]
	if want == nil {
		want = []string{in.Protocol}
	}
	lines := bufio.NewScanner(bytes.NewReader(body))
	lines.Buffer(make([]byte, 64<<10), 1<<20)
	for lines.Scan() {
		line := strings.TrimSpace(lines.Text())
		for _, scheme := range want {
			if strings.HasPrefix(line, scheme+"://") {
				return line, nil
			}
		}
	}
	return "", driver.NewFault(driver.FaultProtocol, op, 0,
		fmt.Errorf("user %q has no %s link", client.RemoteID, in.Protocol))
}

// SubscriptionURL resolves Marzneshin's subscription_url. It is a path unless
// the admin or the panel sets a prefix, and a path is resolved against the
// client base url (F-027-bg). The interface has no error: a failed read
// answers false, and the caller falls back to BuildLink.
func (d *Driver) SubscriptionURL(ctx context.Context, remoteID string) (string, bool) {
	u, err := d.getUser(ctx, "SubscriptionURL", remoteID)
	if err != nil {
		return "", false
	}
	return d.subscription(u)
}

// ClientLinks is the whole of the user's public subscription in `links` form,
// read without the admin token (rule 9, contract.links.md). A user with no
// subscription_url has no links to give.
func (d *Driver) ClientLinks(ctx context.Context, client driver.RemoteClient) ([]string, error) {
	const op = "ClientLinks"
	u, err := d.getUser(ctx, op, client.RemoteID)
	if err != nil {
		return nil, err
	}
	sub, ok := d.subscription(u)
	if !ok {
		return nil, nil
	}
	return driver.FetchLinks(ctx, d.http, op, strings.TrimRight(sub, "/")+"/links")
}

func (d *Driver) subscription(u user) (string, bool) {
	if u.SubscriptionURL == "" {
		return "", false
	}
	ref, err := url.Parse(u.SubscriptionURL)
	if err != nil {
		return "", false
	}
	return d.client.ResolveReference(ref).String(), true
}

func isProtocol(p string) bool {
	for _, known := range protocols {
		if p == known {
			return true
		}
	}
	return false
}
