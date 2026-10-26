package xuifamily

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"network-service/internal/driver"
)

// BuildLink: the panel assembles share links in its browser page, from the
// inbound's stream settings, and serves them only through its subscription
// server. A link assembled here would be a second implementation of that page
// and would disagree with it, so the subscription is the link.
func (d *Driver) BuildLink(context.Context, driver.RemoteClient, driver.Inbound) (string, error) {
	return "", driver.NewFault(driver.FaultUnsupported, "BuildLink", 0,
		errors.New(d.dialect.Panel+" serves links through its subscription server; use SubscriptionURL"))
}

// SubscriptionURL builds the address the panel's own page shows for a client:
// the panel's subURI when it is set, else its sub server's scheme, domain (or
// the panel's host), port and path, then the client's subId. A panel with the
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
	return d.lines(f), nil
}

// lines builds one found client's lines from its inbound: ClientLinks for one
// client, ListClients for every client of the same read.
func (d *Driver) lines(f found) []string {
	return driver.XrayLines(
		driver.XrayInbound{
			Listen: f.inbound.Listen, Port: f.inbound.Port, Protocol: f.inbound.Protocol,
			Remark: f.inbound.Remark, Settings: string(f.inbound.Settings), StreamSettings: string(f.inbound.StreamSettings),
		},
		driver.XrayClient{
			ID: f.client.ID, Password: f.client.Password, Email: f.client.Email,
			Flow: f.client.Flow, Security: f.client.Security,
		},
		d.served.Hostname(),
	)
}

// subscription builds the address from the panel's settings.
func (d *Driver) subscription(ctx context.Context, op, subID string) (string, bool, error) {
	return SubscriptionOf(subID, d.base.Hostname(), func() (SubSettings, error) { return d.subSettings(ctx, op) })
}

// SubscriptionOf is the address for subID on every x-ui shape, the settings
// read only when there is a subID. ok is false for no subId or the sub server
// off; err is a settings read that failed.
func SubscriptionOf(subID, panelHost string, read func() (SubSettings, error)) (string, bool, error) {
	if subID == "" {
		return "", false, nil
	}
	s, err := read()
	if err != nil {
		return "", false, err
	}
	u, ok := s.Address(panelHost, subID)
	return u, ok, nil
}

// subSettings is the panel's sub server settings, one read.
func (d *Driver) subSettings(ctx context.Context, op string) (SubSettings, error) {
	var s SubSettings
	err := d.call(ctx, op, http.MethodPost, d.dialect.Settings, nil, &s)
	return s, err
}

// SubSettings is the sub server's part of the panel's settings, the same on
// every x-ui shape.
type SubSettings struct {
	SubEnable   bool   `json:"subEnable"`
	SubPort     int    `json:"subPort"`
	SubPath     string `json:"subPath"`
	SubDomain   string `json:"subDomain"`
	SubURI      string `json:"subURI"`
	SubCertFile string `json:"subCertFile"`
}

// Address is the subscription address the panel's own page shows for subID:
// its subURI when set, else its sub server's scheme, domain (or panelHost),
// port and path. ok is false with the sub server off.
func (s SubSettings) Address(panelHost, subID string) (string, bool) {
	if !s.SubEnable {
		return "", false
	}
	if s.SubURI != "" {
		return strings.TrimRight(s.SubURI, "/") + "/" + subID, true
	}
	scheme := "http"
	if s.SubCertFile != "" {
		scheme = "https"
	}
	host := s.SubDomain
	if host == "" {
		host = panelHost
	}
	if s.SubPort != 0 && !(scheme == "https" && s.SubPort == 443) && !(scheme == "http" && s.SubPort == 80) {
		host += ":" + strconv.Itoa(s.SubPort)
	}
	path := "/" + strings.Trim(s.SubPath, "/") + "/"
	if path == "//" {
		path = "/"
	}
	return scheme + "://" + host + path + subID, true
}
