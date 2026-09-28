// Package hiddify is the driver for Hiddify Manager panels (F-027-be), over
// its v2 admin API: `<admin proxy path>/api/v2/admin/…`, authenticated by the
// `Hiddify-API-Key` header, whose value is an admin's uuid.
//
// Pull, cumulative, and Hiddify enforces its own per-user limit, so it
// carries ADR-0072. Three of the family's habits are held at the wire:
//
//   - Usage and limit are answered and written in GB, where a GB is 1024³
//     bytes and the figure is a float64. Hiddify's columns are bytes; a
//     float64 holds every byte count below 2^53 exactly, and gb and bytesOf
//     are exact inverses there, so no byte is lost either way.
//   - A `mode` other than `no_reset` zeroes the counter on Hiddify's own
//     schedule. Every write sets `no_reset`, so we stay the only writer of
//     the quota.
//   - A user is addressed by its uuid, which a regenerate changes. The
//     remote id is therefore the user's `name`, created as the uuid without
//     hyphens and never changed by us, and the uuid a write needs is looked
//     up from the last read of the panel.
//
// Links and the subscription are served under the panel's client proxy path,
// which the admin API does not report. The owner registers it as the panel's
// client base url (F-027-bg); without it the driver builds no link.
package hiddify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"network-service/internal/driver"
)

// Driver is one Hiddify panel. It is safe for concurrent use.
type Driver struct {
	base *url.URL
	// client is the scheme, host and client proxy path users are served
	// under; nil when the owner registered none.
	client *url.URL
	key    string
	http   *http.Client
	now    func() time.Time

	mu sync.Mutex
	// uuids is name -> uuid from the last read of the panel. A name held by
	// more than one user maps to "" and is never written to.
	uuids map[string]string
}

var _ driver.Driver = (*Driver)(nil)

// protocols are what Hiddify serves every user, under the one uuid. Which
// transports the panel enables is its own configuration and not read here.
var protocols = []string{"vless", "vmess", "trojan"}

const (
	noReset = "no_reset"
	// gigabyte is Hiddify's ONE_GIG.
	gigabyte = 1 << 30
	// noExpiry is package_days for a client we give no expiry: Hiddify caps
	// remaining_days at this figure, and it is 27 years.
	noExpiry = 10000
	// unlimitedGB is usage_limit_GB for a client wanted with no limit
	// (F-111-r, the user's call 2026-09-26): Hiddify has no "no limit", its 0
	// is a real zero, so the stand-in is 1,000,000 GB. Nothing reads it back
	// as a limit — the config's own flag says unlimited, and the ceiling pass
	// never writes to it.
	unlimitedGB = 1_000_000
	day         = 24 * time.Hour
	date        = "2006-01-02"
)

// New builds a driver over the panel at baseURL: the scheme, host and admin
// proxy path, below which every route is relative. clientBaseURL is the same
// for the client proxy path, often on another domain, or "" for none. key is
// the admin's uuid.
func New(baseURL, clientBaseURL, key string, client *http.Client) (*Driver, error) {
	base, err := absolute(baseURL)
	if err != nil {
		return nil, fmt.Errorf("hiddify: base url %q is not an absolute url", baseURL)
	}
	var clientBase *url.URL
	if strings.TrimSpace(clientBaseURL) != "" {
		if clientBase, err = absolute(clientBaseURL); err != nil {
			return nil, fmt.Errorf("hiddify: client base url %q is not an absolute url", clientBaseURL)
		}
	}
	if strings.TrimSpace(key) == "" {
		return nil, errors.New("hiddify: the api key is empty")
	}
	var own http.Client
	if client != nil {
		own = *client
	}
	// An unknown key is answered with Hiddify's logout redirect, and
	// following it would read the login page as the answer.
	own.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Driver{base: base, client: clientBase, key: strings.TrimSpace(key), http: &own, now: time.Now, uuids: map[string]string{}}, nil
}

func absolute(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, errors.New("not an absolute url")
	}
	return u, nil
}

// ---- wire ------------------------------------------------------------------

type user struct {
	ID             int     `json:"id"`
	UUID           string  `json:"uuid"`
	Name           string  `json:"name"`
	Comment        *string `json:"comment"`
	CurrentUsageGB float64 `json:"current_usage_GB"`
	UsageLimitGB   float64 `json:"usage_limit_GB"`
	PackageDays    *int    `json:"package_days"`
	StartDate      *string `json:"start_date"`
	Mode           string  `json:"mode"`
	Enable         bool    `json:"enable"`
}

// body is PostUserSchema and PatchUserSchema. Hiddify writes only the fields
// present and not null, so every field is omitted unless set; a zero ceiling
// is a pointer to 0.0 and is sent.
type body struct {
	UUID           string   `json:"uuid,omitempty"`
	Name           string   `json:"name,omitempty"`
	Comment        *string  `json:"comment,omitempty"`
	UsageLimitGB   *float64 `json:"usage_limit_GB,omitempty"`
	CurrentUsageGB *float64 `json:"current_usage_GB,omitempty"`
	PackageDays    *int     `json:"package_days,omitempty"`
	StartDate      string   `json:"start_date,omitempty"`
	Mode           string   `json:"mode,omitempty"`
	Enable         *bool    `json:"enable,omitempty"`
}

func gb(b int64) *float64 {
	if b < 0 {
		b = 0
	}
	v := float64(b) / gigabyte
	return &v
}

// usageLimit is usage_limit_GB for a create or an update.
func usageLimit(none bool, bytes int64) *float64 {
	if none {
		v := float64(unlimitedGB)
		return &v
	}
	return gb(bytes)
}

func bytesOf(v float64) int64 { return int64(math.Round(v * gigabyte)) }

func (u user) remote() driver.RemoteClient {
	c := driver.RemoteClient{
		RemoteID:       u.Name,
		UUID:           u.UUID,
		Enabled:        u.Enable,
		DataLimitBytes: bytesOf(u.UsageLimitGB),
		ExpiresAt:      u.expiresAt(),
	}
	if u.Comment != nil {
		c.Label = *u.Comment
	}
	return c
}

// expiresAt reads Hiddify's day count back. A user is served through the
// server's date start_date + package_days; that day reads as the last second
// before it, which is what expiry writes back as the same day (package doc of
// schedule). No start date (counted from first use) or the cap reads as none.
func (u user) expiresAt() time.Time {
	if u.StartDate == nil || u.PackageDays == nil || *u.PackageDays >= noExpiry {
		return time.Time{}
	}
	start, err := time.Parse(date, *u.StartDate)
	if err != nil {
		return time.Time{}
	}
	return start.AddDate(0, 0, *u.PackageDays).Add(-time.Second)
}

// schedule turns an expiry into Hiddify's start_date and package_days. The
// last day served is the day after the expiry's UTC date, so the cut-off is
// never before ours on a server in any timezone, and at most about two days
// after it. Zero is no expiry.
func (d *Driver) schedule(expires time.Time) (string, int) {
	today := d.now().UTC().Truncate(day)
	if expires.IsZero() {
		return today.Format(date), noExpiry
	}
	last := expires.UTC().Truncate(day).Add(day)
	start := today
	if last.Before(start) {
		start = last
	}
	return start.Format(date), int(last.Sub(start) / day)
}

func (d *Driver) desired(claimTag string, limitGB *float64, expires time.Time, enabled bool) body {
	start, days := d.schedule(expires)
	tag := claimTag
	return body{
		Comment:      &tag,
		UsageLimitGB: limitGB,
		PackageDays:  &days,
		StartDate:    start,
		Mode:         noReset,
		Enable:       &enabled,
	}
}

// ---- transport -------------------------------------------------------------

func (d *Driver) url(path string) string {
	return d.base.String() + "/api/v2/admin/" + path
}

func (d *Driver) call(ctx context.Context, op, method, path string, in, out any) error {
	var reader io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return driver.NewFault(driver.FaultProtocol, op, 0, err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, d.url(path), reader)
	if err != nil {
		return driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Hiddify-API-Key", d.key)

	resp, err := d.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return driver.NewFault(driver.FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, err))
		}
		return driver.NewFault(driver.FaultUnavailable, op, 0, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return driver.NewFault(driver.FaultBlocked, op, resp.StatusCode,
			errors.New("the api key was not accepted (answered with a redirect to the login page)"))
	}
	if resp.StatusCode >= 400 {
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

func statusOf(err error) int {
	var fault *driver.Fault
	if errors.As(err, &fault) {
		return fault.Status
	}
	return 0
}

// list reads every user and refreshes the name -> uuid map. Hiddify answers
// a panel with no users as a 404 "You have no user", which is an empty list.
func (d *Driver) list(ctx context.Context, op string) ([]user, time.Time, error) {
	var users []user
	err := d.call(ctx, op, http.MethodGet, "user/", nil, &users)
	if err != nil {
		var fault *driver.Fault
		if !errors.As(err, &fault) || fault.Status != http.StatusNotFound || !strings.Contains(fault.Err.Error(), "no user") {
			return nil, time.Time{}, err
		}
		users = nil
	}
	uuids := make(map[string]string, len(users))
	for _, u := range users {
		if _, twice := uuids[u.Name]; twice {
			uuids[u.Name] = ""
			continue
		}
		uuids[u.Name] = u.UUID
	}
	d.mu.Lock()
	d.uuids = uuids
	d.mu.Unlock()
	return users, time.Now(), nil
}

func (d *Driver) remember(u user) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if have, ok := d.uuids[u.Name]; !ok || have != "" {
		d.uuids[u.Name] = u.UUID
	}
}

func (d *Driver) forget(name string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.uuids, name)
}

// uuidOf answers the uuid a write to this name goes to. found is false for a
// name no user holds. A name two users hold is a protocol fault: writing to
// either could be writing to someone else's client.
func (d *Driver) uuidOf(ctx context.Context, op, name string, fresh bool) (string, bool, error) {
	d.mu.Lock()
	uuid, ok := d.uuids[name]
	d.mu.Unlock()
	if !ok && !fresh {
		if _, _, err := d.list(ctx, op); err != nil {
			return "", false, err
		}
		return d.uuidOf(ctx, op, name, true)
	}
	if !ok {
		return "", false, nil
	}
	if uuid == "" {
		return "", false, driver.NewFault(driver.FaultProtocol, op, 0,
			fmt.Errorf("more than one user is named %q, so neither is written to", name))
	}
	return uuid, true, nil
}

// onUser runs one request against the user a name holds. A 404 is a uuid
// changed since the last read — by hand, or a regenerate elsewhere — so the
// panel is read once and the request sent again.
func (d *Driver) onUser(ctx context.Context, op, name string, send func(uuid string) error) error {
	for attempt := 0; attempt < 2; attempt++ {
		uuid, found, err := d.uuidOf(ctx, op, name, attempt > 0)
		if err != nil {
			return err
		}
		if !found {
			return driver.NewFault(driver.FaultProtocol, op, http.StatusNotFound,
				fmt.Errorf("no user is named %q", name))
		}
		err = send(uuid)
		if statusOf(err) != http.StatusNotFound || attempt > 0 {
			return err
		}
		d.forget(name)
		if _, _, err := d.list(ctx, op); err != nil {
			return err
		}
	}
	return nil
}

func (d *Driver) patch(ctx context.Context, op, name string, b body) (user, error) {
	var out user
	err := d.onUser(ctx, op, name, func(uuid string) error {
		return d.call(ctx, op, http.MethodPatch, "user/"+uuid+"/", b, &out)
	})
	if err == nil {
		d.remember(out)
	}
	return out, err
}

// ---- the driver ------------------------------------------------------------

// Capabilities proves the key, then answers for the family. The one
// per-panel setting that could change a row, the mode, is written by us on
// every write.
func (d *Driver) Capabilities(ctx context.Context) (driver.Capabilities, error) {
	if err := d.HealthCheck(ctx); err != nil {
		return driver.Capabilities{}, err
	}
	yes := func(detail string) driver.Answer { return driver.Answer{Supported: true, Detail: detail} }
	no := func(detail string) driver.Answer { return driver.Answer{Supported: false, Detail: detail} }
	subscription := no("the subscription is served under the client proxy path, which the admin api does not report and was not registered")
	if d.client != nil {
		subscription = yes("the user's page under the registered client proxy path, <client base url>/<uuid>/")
	}
	return driver.Capabilities{
		Version:    driver.CapabilitiesVersion,
		AnsweredAt: time.Now().UTC(),
		Answers: map[driver.RowKey]driver.Answer{
			driver.RowPerClientUsage:          yes("current_usage_GB per user, one total with no up/down split"),
			driver.RowBulkUsageInOneCall:      yes("GET /api/v2/admin/user/ returns every user the key's admin can see, unpaged"),
			driver.RowUsageForNamedSubset:     no("a user is read one uuid per request, so a subset is filtered out of the whole list"),
			driver.RowUsageResetSupported:     yes("PATCH current_usage_GB: 0, believed only when the answer reads 0"),
			driver.RowCounterSurvivesUpdate:   yes("a PATCH without current_usage_GB leaves the counter, and a new uuid is changed on the same row"),
			driver.RowPerClientDataLimit:      yes("usage_limit_GB, enforced by Hiddify itself; 0 is a real zero there"),
			driver.RowDataLimitCountsSameByte: yes("the limit is checked against the same byte column the usage figure reports; both cross as GB = 1024³ bytes in a float64, exact below 2^53 bytes"),
			driver.RowPerClientRateLimit:      no("Hiddify has no per-user bandwidth cap"),
			driver.RowPerClientIPLimit:        no("Hiddify has no per-user address limit"),
			driver.RowEnableDisableClient:     yes("enable true / false"),
			driver.RowClientLifecycle:         yes("POST, PATCH and DELETE /api/v2/admin/user/"),
			driver.RowStableRemoteID:          no("the only id the API addresses is the uuid, which a regenerate changes; the name we key on can be renamed by hand"),
			driver.RowClientLabelStorable:     yes("the comment field"),
			driver.RowNativeSubscriptionLink:  subscription,
			driver.RowServerSideExpiry:        yes("package_days from start_date, in whole days on the server's date; written as the day after ours"),
			driver.RowInternalCreditDisabled:  yes("no credit of its own; mode is written no_reset on every write"),
		},
	}, nil
}

// HealthCheck reads the key's own admin: the cheapest call the key must pass.
func (d *Driver) HealthCheck(ctx context.Context) error {
	return d.call(ctx, "HealthCheck", http.MethodGet, "me/", nil, nil)
}

// ListInbounds: a Hiddify user belongs to no inbound; every protocol is served
// under its one uuid. Each protocol is reported as one inbound on the panel's
// host, so provisioning finds one for any protocol the family serves.
func (d *Driver) ListInbounds(context.Context) ([]driver.Inbound, error) {
	out := make([]driver.Inbound, 0, len(protocols))
	for _, p := range protocols {
		out = append(out, driver.Inbound{RemoteID: p, Tag: p, Protocol: p, Port: 443, Host: d.base.Hostname(), Enabled: true})
	}
	return out, nil
}

func (d *Driver) ListClients(ctx context.Context) ([]driver.RemoteClient, error) {
	users, _, err := d.list(ctx, "ListClients")
	if err != nil {
		return nil, err
	}
	out := make([]driver.RemoteClient, 0, len(users))
	for _, u := range users {
		out = append(out, u.remote())
	}
	return out, nil
}

// CreateClient names the user after its uuid without hyphens and writes the
// whole desired state in the create, so no field falls to Hiddify's defaults
// (1000 GB, 90 days).
func (d *Driver) CreateClient(ctx context.Context, req driver.CreateClientRequest) (driver.RemoteClient, error) {
	const op = "CreateClient"
	if !isProtocol(req.Protocol) {
		return driver.RemoteClient{}, driver.NewFault(driver.FaultUnsupported, op, 0,
			fmt.Errorf("hiddify serves no %q", req.Protocol))
	}
	name := strings.ReplaceAll(req.UUID, "-", "")
	if name == "" {
		return driver.RemoteClient{}, driver.NewFault(driver.FaultProtocol, op, 0, errors.New("no uuid to create the client under"))
	}
	b := d.desired(req.ClaimTag, usageLimit(req.NoDataLimit, req.DataLimitBytes), req.ExpiresAt, req.Enabled)
	b.UUID, b.Name = req.UUID, name
	var created user
	if err := d.call(ctx, op, http.MethodPost, "user/", b, &created); err != nil {
		return driver.RemoteClient{}, err
	}
	d.remember(created)
	return created.remote(), nil
}

// UpdateClient writes the client as it should now be. A new uuid is sent in
// the same PATCH: Hiddify changes it on the same row (add_or_update with
// old_uuid), so the name, the counter and the ceiling stay.
func (d *Driver) UpdateClient(ctx context.Context, req driver.UpdateClientRequest) error {
	b := d.desired(req.ClaimTag, usageLimit(req.NoDataLimit, req.DataLimitBytes), req.ExpiresAt, req.Enabled)
	b.UUID = req.UUID
	_, err := d.patch(ctx, "UpdateClient", req.RemoteID, b)
	return err
}

func (d *Driver) SetClientEnabled(ctx context.Context, remoteID string, enabled bool) error {
	_, err := d.patch(ctx, "SetClientEnabled", remoteID, body{Enable: &enabled, Mode: noReset})
	return err
}

// DeleteClient: a client no user holds any more is already deleted.
func (d *Driver) DeleteClient(ctx context.Context, remoteID string) error {
	const op = "DeleteClient"
	err := d.onUser(ctx, op, remoteID, func(uuid string) error {
		return d.call(ctx, op, http.MethodDelete, "user/"+uuid+"/", nil, nil)
	})
	if statusOf(err) == http.StatusNotFound {
		err = nil
	}
	if err == nil {
		d.forget(remoteID)
	}
	return err
}

// SetClientDataLimit writes the ceiling Hiddify enforces. Hiddify serves a
// user until its usage is above the limit, so zero is written as zero.
func (d *Driver) SetClientDataLimit(ctx context.Context, remoteID string, ceilingBytes int64) error {
	_, err := d.patch(ctx, "SetClientDataLimit", remoteID, body{UsageLimitGB: gb(ceilingBytes), Mode: noReset})
	return err
}

// SetClientIPLimit: Hiddify has no per-user address limit it lets us write.
// "No limit" is already true, and anything else is refused rather than believed.
func (d *Driver) SetClientIPLimit(_ context.Context, _ string, limit int) error {
	if limit <= 0 {
		return nil
	}
	return driver.NewFault(driver.FaultUnsupported, "SetClientIPLimit", 0, errors.New("Hiddify has no per-user address limit"))
}

// SetClientRateLimit: Hiddify has no per-user bandwidth cap.
func (d *Driver) SetClientRateLimit(_ context.Context, _ string, rateBps int64) error {
	if rateBps <= 0 {
		return nil
	}
	return driver.NewFault(driver.FaultUnsupported, "SetClientRateLimit", 0, errors.New("hiddify has no per-user rate limit"))
}

func (d *Driver) GetUsage(ctx context.Context) ([]driver.ClientUsage, error) {
	return d.usage(ctx, "GetUsage", nil)
}

// GetUsageFor is filtered out of the whole list. An empty set is not read.
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

// usage leaves out a name more than one user holds: two counters under one
// remote id would read as resets back and forth.
func (d *Driver) usage(ctx context.Context, op string, want map[string]bool) ([]driver.ClientUsage, error) {
	users, at, err := d.list(ctx, op)
	if err != nil {
		return nil, err
	}
	held := make(map[string]int, len(users))
	for _, u := range users {
		held[u.Name]++
	}
	out := make([]driver.ClientUsage, 0, len(users))
	for _, u := range users {
		if held[u.Name] > 1 || (want != nil && !want[u.Name]) {
			continue
		}
		out = append(out, driver.ClientUsage{RemoteID: u.Name, DownBytes: bytesOf(u.CurrentUsageGB), ObservedAt: at})
	}
	return out, nil
}

// ResetUsage zeroes the counter, and is believed only when the answer reads 0.
func (d *Driver) ResetUsage(ctx context.Context, remoteID string) error {
	const op = "ResetUsage"
	zero := 0.0
	u, err := d.patch(ctx, op, remoteID, body{CurrentUsageGB: &zero})
	if err != nil {
		return err
	}
	if u.CurrentUsageGB != 0 {
		return driver.NewFault(driver.FaultUnsupported, op, 0, fmt.Errorf("the counter reads %v GB after the reset", u.CurrentUsageGB))
	}
	return nil
}

// BuildLink returns the line Hiddify itself serves for the inbound's
// protocol, read from `<client base url>/<uuid>/sub/`: Hiddify builds its
// links per domain and transport from its own configuration, none of which is
// on the admin API, so a link assembled here would not be one it serves. The
// admin key is never sent there. With no client base url it is unsupported.
func (d *Driver) BuildLink(ctx context.Context, client driver.RemoteClient, in driver.Inbound) (string, error) {
	const op = "BuildLink"
	if d.client == nil {
		return "", driver.NewFault(driver.FaultUnsupported, op, 0,
			errors.New("hiddify's links are served under its client proxy path, and the panel was registered without one"))
	}
	if client.UUID == "" {
		return "", driver.NewFault(driver.FaultProtocol, op, 0, errors.New("the client has no uuid"))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.userPage(client.UUID)+"sub/", nil)
	if err != nil {
		return "", driver.NewFault(driver.FaultProtocol, op, 0, err)
	}
	resp, err := d.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", driver.NewFault(driver.FaultTimeout, op, 0, fmt.Errorf("%w: %v", ctxErr, err))
		}
		return "", driver.NewFault(driver.FaultUnavailable, op, 0, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", driver.FaultForStatus(op, resp.StatusCode,
			fmt.Errorf("the client path answered %d: %s", resp.StatusCode, strings.TrimSpace(string(detail))))
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", driver.NewFault(driver.FaultUnavailable, op, 0, err)
	}
	if link, ok := lineFor(string(raw), in.Protocol); ok {
		return link, nil
	}
	return "", driver.NewFault(driver.FaultUnsupported, op, 0,
		fmt.Errorf("hiddify serves this user no %s link", in.Protocol))
}

// lineFor picks the first link of the protocol from a subscription body,
// plain or base64, as Hiddify's `sub/` and `sub64/` answer it.
func lineFor(body, protocol string) (string, bool) {
	for _, line := range driver.ParseLinks([]byte(body)) {
		if strings.HasPrefix(line, protocol+"://") {
			return line, true
		}
	}
	return "", false
}

// SubscriptionURL is the user's page under the client base url,
// `<client base url>/<uuid>/`: Hiddify's own share link, which answers each
// client app in the format it asks for. The uuid is the one the name holds
// now; a name no user holds, or a failed read, answers false, as Marzban's
// does, and the caller falls back to BuildLink.
func (d *Driver) SubscriptionURL(ctx context.Context, remoteID string) (string, bool) {
	if d.client == nil {
		return "", false
	}
	uuid, found, err := d.uuidOf(ctx, "SubscriptionURL", remoteID, false)
	if err != nil || !found {
		return "", false
	}
	return d.userPage(uuid), true
}

// ClientLinks is every line Hiddify serves the user at
// `<client base url>/<uuid>/sub/`, without the admin key (rule 8,
// contract.links.md). With no client base url the panel has none to give.
func (d *Driver) ClientLinks(ctx context.Context, client driver.RemoteClient) ([]string, error) {
	const op = "ClientLinks"
	if d.client == nil {
		return nil, nil
	}
	if client.UUID == "" {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0, errors.New("the client has no uuid"))
	}
	return driver.FetchLinks(ctx, d.http, op, d.userPage(client.UUID)+"sub/")
}

func (d *Driver) userPage(uuid string) string {
	return d.client.String() + "/" + url.PathEscape(uuid) + "/"
}

func isProtocol(p string) bool {
	for _, known := range protocols {
		if p == known {
			return true
		}
	}
	return false
}
