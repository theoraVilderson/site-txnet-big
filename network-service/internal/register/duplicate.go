package register

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"time"

	"network-service/internal/anchor"
	"network-service/internal/driver"
)

// A panel is registered once (F-027-ce, ADR-0090 decision 1). billing refuses
// the same address twice (F-027-cd); this is the same panel under another
// one — a second domain, or its bare IP. It is asked of the panel itself,
// because only the panel knows which server it is:
//
//  1. A client that is another non-retired panel's anchor names that panel
//     (F-027-ey, ADR-0130 decision 3): the anchor is the server's identity.
//     A client carrying only a claim tag (or Xray uuid) of another panel's
//     config, with no anchor of that panel, is a leftover — a warning naming
//     no panel, never a refusal: otherwise a server once used by panel A would
//     be refused to anyone, forever.
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
	// AnchorHolder is the non-retired panel other than panelID whose anchor
	// tag is one of tags or whose anchor uuid is one of uuids.
	AnchorHolder(ctx context.Context, panelID string, tags, uuids []string) (Holder, bool, error)
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
// leftovers is true when it carries clients of another panel's configs that
// named no holder: the caller warns, and takes it.
func (r *Registrar) duplicateOf(ctx context.Context, d driver.Driver, p Pending) (holder Holder, found, leftovers bool, err error) {
	clients, err := d.ListClients(ctx)
	if err != nil {
		return Holder{}, false, false, fmt.Errorf("duplicate check: listing clients: %w", err)
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
		if holder, found, err = r.Store.AnchorHolder(ctx, p.PanelID, tags, uuids); err != nil || found {
			return holder, found, false, err
		}
		if _, leftovers, err = r.Store.ClaimHolder(ctx, p.PanelID, tags, uuids); err != nil {
			return Holder{}, false, false, err
		}
	}
	holder, found, err = r.bySuspects(ctx, d, p)
	return holder, found, leftovers, err
}

// bySuspects is rule 7: a canary through every registered panel the new one
// looks like.
func (r *Registrar) bySuspects(ctx context.Context, d driver.Driver, p Pending) (Holder, bool, error) {

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
	inbounds, err := canaryInbounds(ctx, reg, rd)
	if err != nil {
		return false, err
	}
	created, err := anchor.Create(ctx, rd, inbounds, "canary-", r.now().Add(time.Hour))
	if err != nil {
		return false, err
	}
	tag, uuid := created.Tag, created.UUID
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

// canaryInbounds is the registered panel's recorded inbounds with a protocol
// we sell, else the enabled ones it lists now.
func canaryInbounds(ctx context.Context, reg Registered, rd driver.Driver) ([]anchor.Inbound, error) {
	var sold []anchor.Inbound
	for _, in := range reg.Inbounds {
		if in.Protocol != "" {
			sold = append(sold, anchor.Inbound{RemoteID: in.RemoteID, Protocol: in.Protocol})
		}
	}
	if len(sold) > 0 {
		return sold, nil
	}
	return anchor.Inbounds(ctx, rd)
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
