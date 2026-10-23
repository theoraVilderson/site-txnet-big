// Package source reads another panel a reseller is leaving (F-201-b, D-63):
// the snapshot an import's dry run is built from. It is read-only by type —
// every function here takes a Reader, the read half of driver.Driver, so a
// write to the source panel does not compile — and the conformance case
// `conformance.RunReadOnly` proves each family's reads change nothing at the
// far end.
//
// The source panel is adversarial input (catalog §16): it is dialed through
// the egress guard with no redirect followed and every answer capped
// (HTTPClient), and a panel past MaxClients is refused whole.
package source

import (
	"context"
	"errors"
	"fmt"
	"time"

	"network-service/internal/driver"
)

// Reader is the read half of driver.Driver — the only methods a snapshot may
// call (D-63: the source panel is never written to).
type Reader interface {
	ListInbounds(ctx context.Context) ([]driver.Inbound, error)
	ListClients(ctx context.Context) ([]driver.RemoteClient, error)
	GetUsage(ctx context.Context) ([]driver.ClientUsage, error)
	SubscriptionURL(ctx context.Context, remoteID string) (string, bool)
	ClientLinks(ctx context.Context, client driver.RemoteClient) ([]string, error)
}

var _ Reader = driver.Driver(nil)

// IsFamily is whether an import reads panels of the family (catalog F-201:
// Marzban, Marzneshin, the x-ui forks, 3x-ui, S-UI, Hiddify; F-1601: User
// Manager, whose users are imported in place, ADR-0160). One with no
// driver yet is still a source; opening it answers opener.ErrNoDriver
// until its driver ships (legacy x-ui `x_ui_vaxilu`).
func IsFamily(f driver.DriverType) bool {
	switch f {
	case driver.DriverMarzban, driver.DriverMarzneshin, driver.DriverSanaee, driver.DriverThreeXUI,
		driver.DriverXUIAlireza, driver.DriverXUIVaxilu, driver.DriverSUI, driver.DriverHiddify,
		driver.DriverMikrotikUserManager:
		return true
	}
	return false
}

// ReadInPlace is whether an import reads the family's users in place
// (ADR-0160): from the tenant's registered panel with its own login, never a
// source login. The one place the question is answered (C-18).
func ReadInPlace(f driver.DriverType) bool {
	return f == driver.DriverMikrotikUserManager
}

// DefaultMaxClients is the most clients one source may hold (F-201-b). A
// reseller past it is a conversation, not a batch: the dry run's report and
// the commit are sized for it.
const DefaultMaxClients = 20_000

// ErrTooManyClients is a source past its Limits; nothing of it is answered.
var ErrTooManyClients = errors.New("source: more clients than an import takes")

// Limits bounds one snapshot. Zero fields are the defaults.
type Limits struct {
	MaxClients int
}

func (l Limits) maxClients() int {
	if l.MaxClients > 0 {
		return l.MaxClients
	}
	return DefaultMaxClients
}

// Inbound is a source inbound, as the import's mapping step lists it.
type Inbound struct {
	RemoteID string `json:"remoteId"`
	Tag      string `json:"tag"`
	Protocol string `json:"protocol"`
	Port     int    `json:"port"`
	Enabled  bool   `json:"enabled"`
}

// Client is one source client, normalised: what F-202's mapping reads and a
// `migration_item` keeps as its snapshot. Protocol is its inbound's, where
// the family scopes clients to one; ExpiresAt is nil where it has no end.
type Client struct {
	RemoteID        string     `json:"remoteId"`
	Label           string     `json:"label"`
	UUID            string     `json:"uuid"`
	InboundRemoteID string     `json:"inboundRemoteId"`
	Protocol        string     `json:"protocol"`
	Enabled         bool       `json:"enabled"`
	DataLimitBytes  int64      `json:"dataLimitBytes"`
	UpBytes         int64      `json:"upBytes"`
	DownBytes       int64      `json:"downBytes"`
	ExpiresAt       *time.Time `json:"expiresAt"`
	// Lines are the client's link lines where the list read them (LinesRead);
	// the rest come from Links.
	Lines     []string `json:"lines"`
	LinesRead bool     `json:"linesRead"`
	// SubscriptionURL is the address the client's user holds on the old
	// panel, where its family lists it in bulk (driver.SubscriptionsReader):
	// the legacy path an import keeps answering (F-203-a). Empty is none.
	SubscriptionURL string `json:"subscriptionUrl,omitempty"`
	// TelegramID is the client's Telegram account, where its family names one
	// (driver.RemoteClient): the bot user an import links (F-210). Empty is none.
	TelegramID string `json:"telegramId,omitempty"`
}

// Panel is one snapshot: every inbound and every client.
type Panel struct {
	Inbounds []Inbound `json:"inbounds"`
	Clients  []Client  `json:"clients"`
}

// Snapshot reads the whole source in its bulk calls only — inbounds, clients,
// usage and, where the family lists them, subscription URLs — so a 20 000-client
// panel costs a few requests. Per-client reads (links) are Links', in batches
// (user, 2026-10-21). A family imported in place (driver.AccountsReader) is
// read through its own three instead.
func Snapshot(ctx context.Context, r Reader, lim Limits) (Panel, error) {
	read := bulkReadOf(r)
	inbounds, err := read.inbounds(ctx)
	if err != nil {
		return Panel{}, err
	}
	remote, err := read.clients(ctx)
	if err != nil {
		return Panel{}, err
	}
	if len(remote) > lim.maxClients() {
		return Panel{}, fmt.Errorf("%w: %d, the cap is %d", ErrTooManyClients, len(remote), lim.maxClients())
	}
	usage, err := read.usage(ctx)
	if err != nil {
		return Panel{}, err
	}
	clients := clientsOf(remote, inbounds, usage)
	if err := withSubscriptions(ctx, r, clients); err != nil {
		return Panel{}, err
	}
	return Panel{Inbounds: inboundsOf(inbounds), Clients: clients}, nil
}

// bulkRead is the three calls a snapshot is made of.
type bulkRead struct {
	inbounds func(context.Context) ([]driver.Inbound, error)
	clients  func(context.Context) ([]driver.RemoteClient, error)
	usage    func(context.Context) ([]driver.ClientUsage, error)
}

// bulkReadOf is the family's: an Xray panel's inbounds, clients and usage, or
// — imported in place (ADR-0160) — its profiles, its users without their
// passwords, and what each user's current profile counts (F-1601-f).
func bulkReadOf(r Reader) bulkRead {
	if a, ok := driver.AccountsOf(r); ok {
		return bulkRead{inbounds: a.ListProfiles, clients: a.ListAccounts, usage: a.AccountUsage}
	}
	return bulkRead{inbounds: r.ListInbounds, clients: r.ListClients, usage: r.GetUsage}
}

// withSubscriptions writes each client's own subscription URL onto it. The
// commit can no longer read the source (tenant contract.source-login.md
// rule 5), so the snapshot is where an import learns the old link (F-203-a,
// user 2026-10-21). A family with no bulk list of them leaves every one empty.
func withSubscriptions(ctx context.Context, r Reader, clients []Client) error {
	s, ok := driver.SubscriptionsOf(r)
	if !ok {
		return nil
	}
	urls, err := s.SubscriptionURLs(ctx)
	if err != nil {
		return err
	}
	for i := range clients {
		clients[i].SubscriptionURL = urls[clients[i].RemoteID]
	}
	return nil
}

func inboundsOf(in []driver.Inbound) []Inbound {
	out := make([]Inbound, 0, len(in))
	for _, i := range in {
		out = append(out, Inbound{RemoteID: i.RemoteID, Tag: i.Tag, Protocol: i.Protocol, Port: i.Port, Enabled: i.Enabled})
	}
	return out
}

// clientsOf joins each client to its inbound's protocol and its usage. A
// session family answers one reading per session, so a client's are summed.
func clientsOf(remote []driver.RemoteClient, inbounds []driver.Inbound, usage []driver.ClientUsage) []Client {
	protocol := make(map[string]string, len(inbounds))
	for _, i := range inbounds {
		protocol[i.RemoteID] = i.Protocol
	}
	used := make(map[string][2]int64, len(usage))
	for _, u := range usage {
		sum := used[u.RemoteID]
		used[u.RemoteID] = [2]int64{sum[0] + u.UpBytes, sum[1] + u.DownBytes}
	}
	out := make([]Client, 0, len(remote))
	for _, c := range remote {
		var expires *time.Time
		if !c.ExpiresAt.IsZero() {
			at := c.ExpiresAt.UTC()
			expires = &at
		}
		out = append(out, Client{
			RemoteID: c.RemoteID, Label: c.Label, UUID: c.UUID, InboundRemoteID: c.InboundRemoteID,
			Protocol: protocol[c.InboundRemoteID], Enabled: c.Enabled, DataLimitBytes: c.DataLimitBytes,
			UpBytes: used[c.RemoteID][0], DownBytes: used[c.RemoteID][1], ExpiresAt: expires,
			Lines: c.Lines, LinesRead: c.LinesRead, TelegramID: c.TelegramID,
		})
	}
	return out
}
