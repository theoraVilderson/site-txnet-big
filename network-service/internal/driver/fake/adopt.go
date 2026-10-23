package fake

import (
	"context"
	"fmt"

	"network-service/internal/driver"
)

// The fake as a family imported in place (F-1601-b2): Holds puts a reseller's
// own user on the far end, and the Adopter methods take it over and hand it
// back without touching its credential, as User Manager's driver does.

var _ driver.Adopter = (*Panel)(nil)

// Holds puts a user of the reseller's own on the panel: its own credential,
// its own label, under its own profile and no ceiling of ours.
func (p *Panel) Holds(remoteID, credential, label, profile string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.clients[remoteID] = &client{remoteID: remoteID, uuid: credential, label: label, inbound: profile, enabled: true}
	p.order = append(p.order, remoteID)
}

// ProfileOf is the profile the user is on now: its own, or ours once adopted.
func (p *Panel) ProfileOf(remoteID string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if c := p.clients[remoteID]; c != nil {
		return c.inbound
	}
	return ""
}

// AdoptedProfile is the profile an adopted user is on, as the real driver
// names its chain.
func AdoptedProfile(remoteID string) string { return "txnet-" + remoteID }

func (p *Panel) AdoptClient(ctx context.Context, req driver.AdoptRequest) error {
	if err := p.gate(ctx, "AdoptClient"); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.clients[req.RemoteID]
	if c == nil {
		return p.notFound("AdoptClient", req.RemoteID)
	}
	c.inbound, c.label, c.enabled, c.rateLimit = AdoptedProfile(req.RemoteID), req.ClaimTag, req.Enabled, req.RateLimitBps
	c.dataLimit = req.DataLimitBytes
	if req.NoDataLimit {
		c.dataLimit = 0
	}
	// The counter adoption starts is the profile link's: zero (F-1601-e).
	p.zeroLocked(c)
	return nil
}

func (p *Panel) ReleaseClient(ctx context.Context, req driver.ReleaseRequest) error {
	if err := p.gate(ctx, "ReleaseClient"); err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.clients[req.RemoteID]
	if c == nil {
		return p.notFound("ReleaseClient", req.RemoteID)
	}
	if req.Profile == "" {
		return driver.NewFault(driver.FaultProtocol, "ReleaseClient", 0, fmt.Errorf("no profile to hand %q back to", req.RemoteID))
	}
	c.inbound, c.label, c.dataLimit, c.rateLimit = req.Profile, req.Label, 0, 0
	return nil
}
