package register

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/url"
	"time"

	"network-service/internal/driver"
)

// A panel is registered once (F-027-ce, ADR-0090 decision 1). billing refuses
// the same address twice (F-027-cd); this is the same panel under another
// one — a second domain, or its bare IP. It is asked of the panel itself,
// because only the panel knows which server it is:
//
//  1. A client carrying a claim tag (or Xray uuid) of another panel's config
//     names that panel. Our tags are global (invariant 17), so a match is proof.
//  2. Otherwise each **suspect** — a registered panel with the same inbound
//     set, or the same IP — gets a canary: a disabled client under a random
//     tag, created through the registered panel and looked for here. Seen is
//     the same panel. The canary is deleted either way.
//
// ADR-0090 names the canary for a panel with no clients; it runs for any
// panel whose clients carry nothing of ours, because an existing panel's own
// users are not ours either and would otherwise hide the copy. It costs one
// disabled client on a suspect, and there is no suspect without a match.
//
// A check that cannot run is no verdict: the panel stays `pending` with a
// fault naming the suspect, never refused and never accepted past it.

// InboundKey is one inbound as the duplicate check compares them. Protocol is
// "" where `panel_inbound` holds none (a protocol we do not sell).
type InboundKey struct {
	RemoteID string
	Port     int
	Protocol string
}

// Registered is a panel in service that a new one may turn out to be: pull,
// accepted, not archived. Pending is what the Opener needs to reach it.
type Registered struct {
	Pending
	Name      string
	IPAddress string
	// Inbounds is its `panel_inbound` rows not gone, as last read.
	Inbounds []InboundKey
}

// Holder is the registered panel a duplicate is.
type Holder struct {
	PanelID string
	Name    string
}

// DuplicateStore is what the check reads and writes, beside Store.
type DuplicateStore interface {
	// ClaimHolder is a panel other than panelID with a config whose claim tag
	// is one of tags or whose uuid is one of uuids.
	ClaimHolder(ctx context.Context, panelID string, tags, uuids []string) (Holder, bool, error)
	// Registered is every panel in service other than panelID.
	Registered(ctx context.Context, panelID string) ([]Registered, error)
	// Duplicate writes the verdict `refused`, naming the holder, under Answer's
	// guard: false means the panel was no longer pending at the tested address.
	Duplicate(ctx context.Context, p Pending, caps driver.Capabilities, holder Holder, at time.Time) (bool, error)
}

// canaryDeleteTimeout bounds removing the canary, which runs even when the
// test's own context has ended.
const canaryDeleteTimeout = 10 * time.Second

// duplicateOf asks the new panel, through d, whether it is one registered.
func (r *Registrar) duplicateOf(ctx context.Context, d driver.Driver, p Pending) (Holder, bool, error) {
	clients, err := d.ListClients(ctx)
	if err != nil {
		return Holder{}, false, fmt.Errorf("duplicate check: listing clients: %w", err)
	}
	var tags, uuids []string
	for _, c := range clients {
		if c.Label != "" {
			tags = append(tags, c.Label)
		}
		if c.UUID != "" {
			uuids = append(uuids, c.UUID)
		}
	}
	if len(tags)+len(uuids) > 0 {
		h, found, err := r.Store.ClaimHolder(ctx, p.PanelID, tags, uuids)
		if err != nil || found {
			return h, found, err
		}
	}

	registered, err := r.Store.Registered(ctx, p.PanelID)
	if err != nil || len(registered) == 0 {
		return Holder{}, false, err
	}
	inbounds, err := d.ListInbounds(ctx)
	if err != nil {
		return Holder{}, false, fmt.Errorf("duplicate check: listing inbounds: %w", err)
	}
	ips := r.ipsOf(ctx, p.APIBaseURL)
	for _, reg := range registered {
		if !sameInbounds(reg.Inbounds, inbounds) && !r.sharesIP(ctx, reg, ips) {
			continue
		}
		seen, err := r.canary(ctx, reg, d)
		if err != nil {
			return Holder{}, false, fmt.Errorf("duplicate check: canary on panel %s (%s): %w", reg.Name, reg.PanelID, err)
		}
		if seen {
			return Holder{PanelID: reg.PanelID, Name: reg.Name}, true, nil
		}
	}
	return Holder{}, false, nil
}

// canary creates a disabled client through reg and looks for it through d.
func (r *Registrar) canary(ctx context.Context, reg Registered, d driver.Driver) (bool, error) {
	rd, err := r.Opener.Open(ctx, reg.Pending)
	if err != nil {
		return false, err
	}
	inbound, err := canaryInbound(ctx, reg, rd)
	if err != nil {
		return false, err
	}
	tag, uuid := "canary-"+randomHex(8), randomUUID()
	created, err := rd.CreateClient(ctx, driver.CreateClientRequest{
		ClaimTag: tag, UUID: uuid, InboundRemoteID: inbound.RemoteID, Protocol: inbound.Protocol,
		// One byte, not zero: a family may read 0 as no limit. It is disabled anyway.
		DataLimitBytes: 1, ExpiresAt: r.now().Add(time.Hour), Enabled: false,
	})
	if err != nil {
		return false, err
	}
	defer func() {
		delCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), canaryDeleteTimeout)
		defer cancel()
		if err := rd.DeleteClient(delCtx, created.RemoteID); err != nil {
			r.log().Error("canary client not deleted; it is disabled, remove it by hand",
				"panel", reg.PanelID, "remoteId", created.RemoteID, "tag", tag, "error", err)
		}
	}()

	clients, err := d.ListClients(ctx)
	if err != nil {
		return false, err
	}
	for _, c := range clients {
		if c.Label == tag || c.UUID == uuid {
			return true, nil
		}
	}
	return false, nil
}

// canaryInbound is the registered panel's first recorded inbound with a
// protocol we sell, else the first enabled one it lists now.
func canaryInbound(ctx context.Context, reg Registered, rd driver.Driver) (InboundKey, error) {
	for _, in := range reg.Inbounds {
		if in.Protocol != "" {
			return in, nil
		}
	}
	listed, err := rd.ListInbounds(ctx)
	if err != nil {
		return InboundKey{}, err
	}
	for _, in := range listed {
		if in.Enabled {
			return InboundKey{RemoteID: in.RemoteID, Port: in.Port, Protocol: in.Protocol}, nil
		}
	}
	return InboundKey{}, nil // a family with no inbounds (Hiddify) scopes nothing
}

// sameInbounds is the recorded set equal to the listed one, by remote id and
// port, and protocol where the record has one.
func sameInbounds(recorded []InboundKey, listed []driver.Inbound) bool {
	if len(recorded) == 0 || len(recorded) != len(listed) {
		return false
	}
	byID := make(map[string]InboundKey, len(recorded))
	for _, k := range recorded {
		byID[k.RemoteID] = k
	}
	for _, in := range listed {
		k, ok := byID[in.RemoteID]
		if !ok || k.Port != in.Port || (k.Protocol != "" && k.Protocol != in.Protocol) {
			return false
		}
	}
	return true
}

func (r *Registrar) sharesIP(ctx context.Context, reg Registered, ips map[string]bool) bool {
	if len(ips) == 0 {
		return false
	}
	if reg.IPAddress != "" && ips[canonicalIP(reg.IPAddress)] {
		return true
	}
	for ip := range r.ipsOf(ctx, reg.APIBaseURL) {
		if ips[ip] {
			return true
		}
	}
	return false
}

// ipsOf is the addresses a base url's host resolves to. A lookup that fails
// is no address: the IP is a reason to suspect, never a reason to refuse.
func (r *Registrar) ipsOf(ctx context.Context, baseURL string) map[string]bool {
	u, err := url.Parse(baseURL)
	if err != nil || u.Hostname() == "" {
		return nil
	}
	resolve := r.Resolve
	if resolve == nil {
		resolve = net.DefaultResolver.LookupHost
	}
	addrs, err := resolve(ctx, u.Hostname())
	if err != nil {
		return nil
	}
	out := make(map[string]bool, len(addrs))
	for _, a := range addrs {
		out[canonicalIP(a)] = true
	}
	return out
}

func canonicalIP(s string) string {
	if ip := net.ParseIP(s); ip != nil {
		return ip.String()
	}
	return s
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func randomUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
