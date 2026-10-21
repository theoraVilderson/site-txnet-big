// Package sui reads an S-UI panel (alireza0/s-ui, built on sing-box) for an
// import (F-201-c, D-63). It is the read half of driver.Driver only: S-UI is a
// family a reseller leaves, never one a panel is registered on, so every
// write answers unsupported and opener.HasDriver leaves the family off —
// opener.Build opens it for a source read alone.
//
// It speaks S-UI v1's admin API under the panel's web path, which the
// address the reseller types includes (`https://host:2095/app`):
//
//   - POST api/login (form `user`, `pass`) answers a session cookie
//     (transport.go).
//   - GET api/load answers every inbound, every client and the subscription
//     base `subURI` in one call: the snapshot's bulk read. From v1.1 the
//     client list leaves out each client's config and links; v1.0 carried
//     both, and a list that does is read whole (LinesRead).
//   - GET api/clients?id= answers one client whole: its links, for a link
//     batch.
//
// A client is keyed by its name, which S-UI keeps unique and serves the
// client's subscription under (`<subURI><name>`) — as x-ui's email and
// Marzban's username are. Written against S-UI's source and proved on a
// scripted panel (sui_test.go), not yet on a live one.
package sui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"network-service/internal/driver"
)

// Credentials is an S-UI admin login, read out of the run's vault reference.
type Credentials struct {
	Username string
	Password string
}

// Driver is one S-UI panel, read-only.
type Driver struct {
	// BulkUsage is GetUsage and GetUsageFor over one load.
	driver.BulkUsage

	base *url.URL
	// subBase is the registered client address; nil is the panel's subURI.
	subBase *url.URL
	creds   Credentials
	http    *http.Client

	mu       sync.Mutex
	cookies  []*http.Cookie
	refusals driver.LoginRefusals
	// ids and subURI are from the last load: a link batch finds a client's id
	// and its subscription base by name without a load per client.
	ids    map[string]int
	subURI string
}

var _ driver.Driver = (*Driver)(nil)

// New builds a driver over the panel at baseURL (its web path included).
// clientBaseURL, when given, is where its subscription is served instead of
// the panel's own subURI.
func New(baseURL, clientBaseURL string, creds Credentials, client *http.Client) (*Driver, error) {
	base, err := absolute(baseURL)
	if err != nil {
		return nil, err
	}
	d := &Driver{base: base, creds: creds, http: client}
	if clientBaseURL != "" {
		if d.subBase, err = absolute(clientBaseURL); err != nil {
			return nil, err
		}
	}
	d.BulkUsage = d.usage
	return d, nil
}

func absolute(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("not an absolute http(s) address: %q", raw)
	}
	return u, nil
}

// wireInbound is a sing-box inbound as api/load lists it.
type wireInbound struct {
	ID         int    `json:"id"`
	Type       string `json:"type"`
	Tag        string `json:"tag"`
	ListenPort int    `json:"listen_port"`
}

// wireClient is an S-UI client. Volume is bytes and 0 is no limit; Expiry is
// unix seconds and 0 is none; up and down are the panel's running totals.
type wireClient struct {
	ID       int                        `json:"id"`
	Enable   bool                       `json:"enable"`
	Name     string                     `json:"name"`
	Inbounds []int                      `json:"inbounds"`
	Config   map[string]json.RawMessage `json:"config"`
	Links    []wireLink                 `json:"links"`
	Volume   int64                      `json:"volume"`
	Expiry   int64                      `json:"expiry"`
	Up       int64                      `json:"up"`
	Down     int64                      `json:"down"`
}

// wireLink is one of a client's links: its own (`local`), an operator's
// (`external`) or another subscription's (`sub`) — all of them what the
// panel's subscription serves, so all of them kept.
type wireLink struct {
	URI string `json:"uri"`
}

type loaded struct {
	Inbounds []wireInbound `json:"inbounds"`
	Clients  []wireClient  `json:"clients"`
	SubURI   string        `json:"subURI"`
}

// load is the bulk read, and refreshes the name index a link batch uses.
func (d *Driver) load(ctx context.Context, op string) (loaded, time.Time, error) {
	var got loaded
	if err := d.get(ctx, op, "load", nil, &got); err != nil {
		return loaded{}, time.Time{}, err
	}
	ids := make(map[string]int, len(got.Clients))
	for _, c := range got.Clients {
		ids[c.Name] = c.ID
	}
	d.mu.Lock()
	d.ids, d.subURI = ids, got.SubURI
	d.mu.Unlock()
	return got, time.Now(), nil
}

func (d *Driver) ListInbounds(ctx context.Context) ([]driver.Inbound, error) {
	got, _, err := d.load(ctx, "ListInbounds")
	if err != nil {
		return nil, err
	}
	out := make([]driver.Inbound, 0, len(got.Inbounds))
	for _, in := range got.Inbounds {
		// A sing-box inbound that exists is serving: S-UI has no switch.
		// Its type is passed as it is; one we do not sell is the dry run's
		// `unknown_protocol` to skip.
		out = append(out, driver.Inbound{
			RemoteID: strconv.Itoa(in.ID), Tag: in.Tag, Protocol: in.Type, Port: in.ListenPort, Enabled: true,
		})
	}
	return out, nil
}

func (d *Driver) ListClients(ctx context.Context) ([]driver.RemoteClient, error) {
	got, _, err := d.load(ctx, "ListClients")
	if err != nil {
		return nil, err
	}
	out := make([]driver.RemoteClient, 0, len(got.Clients))
	for _, c := range got.Clients {
		out = append(out, remoteClient(c))
	}
	return out, nil
}

// remoteClient is the normalised client. A client on several inbounds is
// listed under its first: the import maps one inbound to one product.
func remoteClient(c wireClient) driver.RemoteClient {
	rc := driver.RemoteClient{
		RemoteID: c.Name, Label: c.Name, UUID: identity(c.Config),
		Enabled: c.Enable, DataLimitBytes: c.Volume,
	}
	if len(c.Inbounds) > 0 {
		rc.InboundRemoteID = strconv.Itoa(c.Inbounds[0])
	}
	if c.Expiry > 0 {
		rc.ExpiresAt = time.Unix(c.Expiry, 0).UTC()
	}
	if c.Links != nil {
		rc.Lines, rc.LinesRead = uris(c.Links), true
	}
	return rc
}

// identity is the client's Xray-style uuid, from whichever of its protocol
// configs carries one; empty when the list left config out (v1.1).
func identity(config map[string]json.RawMessage) string {
	for _, protocol := range []string{"vless", "vmess", "tuic"} {
		var user struct {
			UUID string `json:"uuid"`
		}
		if raw, ok := config[protocol]; ok && json.Unmarshal(raw, &user) == nil && user.UUID != "" {
			return user.UUID
		}
	}
	return ""
}

func uris(links []wireLink) []string {
	out := make([]string, 0, len(links))
	for _, l := range links {
		if l.URI != "" {
			out = append(out, l.URI)
		}
	}
	return out
}

func (d *Driver) usage(ctx context.Context, op string, want map[string]bool) ([]driver.ClientUsage, error) {
	got, at, err := d.load(ctx, op)
	if err != nil {
		return nil, err
	}
	out := make([]driver.ClientUsage, 0, len(got.Clients))
	for _, c := range got.Clients {
		if want == nil || want[c.Name] {
			out = append(out, driver.ClientUsage{RemoteID: c.Name, UpBytes: c.Up, DownBytes: c.Down, ObservedAt: at})
		}
	}
	return out, nil
}

// SubscriptionURL is the client's subscription: the registered client
// address, else the panel's subURI, joined with the name.
func (d *Driver) SubscriptionURL(ctx context.Context, name string) (string, bool) {
	if d.subBase != nil {
		return d.subBase.JoinPath(name).String(), true
	}
	if _, err := d.index(ctx, "SubscriptionURL"); err != nil {
		return "", false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.subURI == "" {
		return "", false
	}
	return d.subURI + url.PathEscape(name), true
}

// ClientLinks reads the client whole and answers the panel's own links. A
// client the panel no longer holds is a protocol fault: that client's, never
// the batch's.
func (d *Driver) ClientLinks(ctx context.Context, client driver.RemoteClient) ([]string, error) {
	const op = "ClientLinks"
	ids, err := d.index(ctx, op)
	if err != nil {
		return nil, err
	}
	id, ok := ids[client.RemoteID]
	if !ok {
		return nil, driver.NewFault(driver.FaultProtocol, op, http.StatusNotFound, fmt.Errorf("no client %q on the panel", client.RemoteID))
	}
	var got struct {
		Clients []wireClient `json:"clients"`
	}
	if err := d.get(ctx, op, "clients", url.Values{"id": {strconv.Itoa(id)}}, &got); err != nil {
		return nil, err
	}
	if len(got.Clients) != 1 || got.Clients[0].Name != client.RemoteID {
		return nil, driver.NewFault(driver.FaultProtocol, op, http.StatusNotFound, fmt.Errorf("the panel did not answer client %q", client.RemoteID))
	}
	return uris(got.Clients[0].Links), nil
}

// index is the name → id map of the last load, loading once if this driver
// has not read the panel yet (a link batch's fresh driver).
func (d *Driver) index(ctx context.Context, op string) (map[string]int, error) {
	d.mu.Lock()
	ids := d.ids
	d.mu.Unlock()
	if ids != nil {
		return ids, nil
	}
	if _, _, err := d.load(ctx, op); err != nil {
		return nil, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.ids, nil
}

// errReadOnly is every write's: the S-UI driver exists for an import, and
// an import never writes to the panel it reads (D-63).
var errReadOnly = errors.New("the S-UI driver reads a source panel for an import and never writes")

func unsupported(op string) error {
	return driver.NewFault(driver.FaultUnsupported, op, 0, errReadOnly)
}

// Capabilities is the registration call, and an S-UI panel is never registered.
func (d *Driver) Capabilities(context.Context) (driver.Capabilities, error) {
	return driver.Capabilities{}, unsupported("Capabilities")
}

// HealthCheck proves the login: one login, nothing read.
func (d *Driver) HealthCheck(ctx context.Context) error {
	_, err := d.login(ctx, "HealthCheck")
	return err
}

func (d *Driver) CreateClient(context.Context, driver.CreateClientRequest) (driver.RemoteClient, error) {
	return driver.RemoteClient{}, unsupported("CreateClient")
}
func (d *Driver) UpdateClient(context.Context, driver.UpdateClientRequest) error {
	return unsupported("UpdateClient")
}
func (d *Driver) SetClientEnabled(context.Context, string, bool) error {
	return unsupported("SetClientEnabled")
}
func (d *Driver) DeleteClient(context.Context, string) error { return unsupported("DeleteClient") }
func (d *Driver) SetClientDataLimit(context.Context, string, int64) error {
	return unsupported("SetClientDataLimit")
}
func (d *Driver) SetClientRateLimit(context.Context, string, int64) error {
	return unsupported("SetClientRateLimit")
}
func (d *Driver) SetClientIPLimit(context.Context, string, int) error {
	return unsupported("SetClientIPLimit")
}
func (d *Driver) ResetUsage(context.Context, string) error { return unsupported("ResetUsage") }

// BuildLink is unsupported: a link is the panel's (ClientLinks), never one
// assembled here (ADR-0082 rule 2).
func (d *Driver) BuildLink(context.Context, driver.RemoteClient, driver.Inbound) (string, error) {
	return "", unsupported("BuildLink")
}
