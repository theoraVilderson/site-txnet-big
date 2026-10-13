package xuifamily

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"network-service/internal/driver"
)

// Capabilities proves the login, then answers for the family. The one
// per-client choice that could change a row, an auto-reset, is either absent
// or written 0 by us on every write (Dialect.HoldsReset).
func (d *Driver) Capabilities(ctx context.Context) (driver.Capabilities, error) {
	if err := d.HealthCheck(ctx); err != nil {
		return driver.Capabilities{}, err
	}
	yes := func(detail string) driver.Answer { return driver.Answer{Supported: true, Detail: detail} }
	no := func(detail string) driver.Answer { return driver.Answer{Supported: false, Detail: detail} }
	panel := d.dialect.Panel
	return driver.Capabilities{
		Version:    driver.CapabilitiesVersion,
		AnsweredAt: time.Now().UTC(),
		Answers: map[driver.RowKey]driver.Answer{
			driver.RowPerClientUsage:          yes("clientStats up and down per client email"),
			driver.RowBulkUsageInOneCall:      yes("GET /" + strings.Join(d.dialect.List, "/") + " carries every client's counters"),
			driver.RowUsageForNamedSubset:     no("getClientTraffics reads one email per request; a subset is served from the bulk call"),
			driver.RowUsageResetSupported:     yes("POST /" + strings.Join(d.dialect.Inbounds, "/") + "/{id}/resetClientTraffic/{email}"),
			driver.RowCounterSurvivesUpdate:   yes("updateClient keeps up and down while the email is unchanged, and we never change it"),
			driver.RowPerClientDataLimit:      yes("totalGB, enforced by " + panel + "'s depletion job; zero is written as one byte, since 0 is unlimited there"),
			driver.RowDataLimitCountsSameByte: yes("the total is checked against up plus down, the figures we read"),
			driver.RowPerClientRateLimit:      no(panel + " has no per-client bandwidth cap; limitIp counts addresses"),
			driver.RowPerClientIPLimit:        yes("limitIp, the distinct addresses " + panel + " lets one client use at once; enforced by its IP-limit job, which needs the Xray access log and fail2ban on the server"),
			driver.RowEnableDisableClient:     yes("the client's enable flag"),
			driver.RowClientLifecycle:         yes("addClient, updateClient, delClient; an inbound's last client cannot be deleted and is disabled instead"),
			driver.RowStableRemoteID:          yes("the email, which we never change"),
			driver.RowClientLabelStorable:     yes(d.dialect.LabelDetail),
			driver.RowNativeSubscriptionLink:  yes("the panel's subscription server, by the client's subId"),
			driver.RowServerSideExpiry:        yes("expiryTime, enforced by " + panel + " itself"),
			driver.RowInternalCreditDisabled:  yes(d.dialect.CreditDetail),
		},
	}, nil
}

// HealthCheck reads the inbound list: the panel has no cheaper call every
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
	rows := make([]Inbound, 0, len(list))
	for _, in := range list {
		rows = append(rows, in.Inbound)
	}
	return InboundsOf(rows), nil
}

// ListClients reads the panel, never our last write: the limit reported is
// the one the panel's counters row holds now.
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
		c := f.remote()
		c.Lines, c.LinesRead = d.lines(f), true
		out = append(out, c)
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
			fmt.Errorf("%s clients are provisioned on %v, not %q", d.dialect.Panel, protocols, req.Protocol))
	}
	inboundID, err := strconv.Atoi(req.InboundRemoteID)
	if err != nil {
		return driver.RemoteClient{}, driver.NewFault(driver.FaultProtocol, op, 0,
			fmt.Errorf("inbound %q is not a numeric %s inbound id", req.InboundRemoteID, d.dialect.Panel))
	}
	subID := req.SubscriptionKey
	if subID == "" {
		if subID, err = NewSubID(); err != nil {
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
		TotalGB:    Limit(req.NoDataLimit, req.DataLimitBytes),
		ExpiryTime: Expiry(req.ExpiresAt),
		Comment:    req.ClaimTag,
		SubID:      subID,
		LimitIP:    req.IPLimit,
	}
	credential(&c, req.Protocol, req.UUID)
	if err := d.write(ctx, op, d.inbounds("addClient"), inboundID, c); err != nil {
		return driver.RemoteClient{}, err
	}
	return found{inbound: inbound{Inbound: Inbound{ID: inboundID}}, client: c, protocol: req.Protocol}.remote(), nil
}

// UpdateClient writes the whole client as it should now be. The inbound and
// the protocol are the ones the client has: the panel cannot move a client.
func (d *Driver) UpdateClient(ctx context.Context, req driver.UpdateClientRequest) error {
	const op = "UpdateClient"
	f, err := d.mustFind(ctx, op, req.RemoteID)
	if err != nil {
		return err
	}
	if req.InboundRemoteID != "" && req.InboundRemoteID != strconv.Itoa(f.inbound.ID) {
		return driver.NewFault(driver.FaultUnsupported, op, 0,
			fmt.Errorf("%s cannot move client %q to inbound %s", d.dialect.Panel, req.RemoteID, req.InboundRemoteID))
	}
	key := f.key()
	next := f.client
	credential(&next, f.protocol, req.UUID)
	next.Enable = req.Enabled
	next.TotalGB = Limit(req.NoDataLimit, req.DataLimitBytes)
	next.ExpiryTime = Expiry(req.ExpiresAt)
	next.Comment = req.ClaimTag
	next.LimitIP = req.IPLimit
	return d.write(ctx, op, d.inbounds("updateClient", key), f.inbound.ID, next)
}

func (d *Driver) SetClientEnabled(ctx context.Context, remoteID string, enabled bool) error {
	return d.update(ctx, "SetClientEnabled", remoteID, func(c *client) { c.Enable = enabled })
}

// DeleteClient removes the client. A client already gone is done. The panel
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
		if err := d.write(ctx, op, d.inbounds("updateClient", f.key()), f.inbound.ID, next); err != nil {
			return err
		}
		return driver.NewFault(driver.FaultUnsupported, op, 0,
			fmt.Errorf("client %q is the last on inbound %d, which %s keeps; it is disabled", remoteID, f.inbound.ID, d.dialect.Panel))
	}
	return d.call(ctx, op, http.MethodPost, d.inbounds(strconv.Itoa(f.inbound.ID), "delClient", f.key()), nil, nil)
}

// SetClientDataLimit writes the ceiling the panel enforces. Raising it above
// what was used is also what lets a depleted client through again.
func (d *Driver) SetClientDataLimit(ctx context.Context, remoteID string, ceilingBytes int64) error {
	return d.update(ctx, "SetClientDataLimit", remoteID, func(c *client) { c.TotalGB = Ceiling(ceilingBytes) })
}

// SetClientRateLimit: the panel has no per-client bandwidth cap. "No cap" is
// already true, and anything else is refused rather than believed.
func (d *Driver) SetClientRateLimit(_ context.Context, _ string, rateBps int64) error {
	if rateBps <= 0 {
		return nil
	}
	return driver.NewFault(driver.FaultUnsupported, "SetClientRateLimit", 0,
		errors.New(d.dialect.Panel+" has no per-client rate limit"))
}

// SetClientIPLimit writes limitIp, the Grant's device limit (F-311-q).
func (d *Driver) SetClientIPLimit(ctx context.Context, remoteID string, limit int) error {
	return d.update(ctx, "SetClientIPLimit", remoteID, func(c *client) { c.LimitIP = limit })
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
	return d.call(ctx, op, http.MethodPost, d.inbounds(strconv.Itoa(f.inbound.ID), "resetClientTraffic", remoteID), nil, nil)
}
