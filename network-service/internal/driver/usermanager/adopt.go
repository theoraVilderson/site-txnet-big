package usermanager

import (
	"context"
	"errors"
	"fmt"
	"net/url"

	"network-service/internal/driver"
)

// Adoption in place (ADR-0160, F-1601-b2): a reseller's user keeps its login
// on the router, and only its profile changes hands. The password is never
// in a body here, read or written.

var _ driver.Adopter = (*Driver)(nil)

// AdoptClient links our chain, then detaches the user's own profiles — in
// that order, so the user is never left with none — and writes our claim tag
// last: until the tag is there the adoption is not done, and the next pass
// repeats it. `transfer-limit` counts from the link (F-1601-e), so the
// ceiling is the remaining allocation and nothing the user used before.
func (d *Driver) AdoptClient(ctx context.Context, req driver.AdoptRequest) error {
	const op = "AdoptClient"
	user := req.RemoteID
	transfer := transferLimit(req.NoDataLimit, req.DataLimitBytes)
	if err := d.ensureChain(ctx, op, user, transfer, req.RateLimitBps, func() error { return nil }); err != nil {
		return err
	}
	if err := d.unlinkProfiles(ctx, op, user, func(profile string) bool { return profile != chainName(user) }); err != nil {
		return err
	}
	return d.patch(ctx, op, "user", user, row{"comment": req.ClaimTag, "disabled": disabled(req.Enabled)})
}

// ReleaseClient hands the user back: its own profile linked again first, then
// our link and chain removed, then its own comment. A profile the reseller
// has deleted since is refused before anything comes off. User Manager counts
// a profile from its link, so the profile starts again (ADR-0160 decision 7).
func (d *Driver) ReleaseClient(ctx context.Context, req driver.ReleaseRequest) error {
	const op = "ReleaseClient"
	user, chain := req.RemoteID, chainName(req.RemoteID)
	own, err := d.list(ctx, op, "profile", url.Values{"name": {req.Profile}})
	if err != nil {
		return err
	}
	if len(own) == 0 {
		return driver.NewFault(driver.FaultProtocol, op, 0,
			fmt.Errorf("user %q cannot be handed back: its profile %q is gone from the router", user, req.Profile))
	}
	if err := d.ensureLink(ctx, op, "user-profile", row{"user": user, "profile": req.Profile}); err != nil {
		return err
	}
	if err := d.unlinkProfiles(ctx, op, user, func(profile string) bool { return profile == chain }); err != nil {
		return err
	}
	if err := d.removeChain(ctx, op, chain); err != nil {
		return err
	}
	return d.patch(ctx, op, "user", user, row{"comment": req.Label})
}

// unlinkProfiles removes the user's profile links whose profile drop names.
func (d *Driver) unlinkProfiles(ctx context.Context, op, user string, drop func(profile string) bool) error {
	links, err := d.list(ctx, op, "user-profile", url.Values{"user": {user}})
	if err != nil {
		return err
	}
	var errs []error
	for _, l := range links {
		if drop(l["profile"]) {
			errs = append(errs, d.remove(ctx, op, "user-profile", l[".id"]))
		}
	}
	return errors.Join(errs...)
}

// removeChain removes a chain's own rows: the profile's limitation links, the
// profile, the limitation. No user may still hold the profile.
func (d *Driver) removeChain(ctx context.Context, op, chain string) error {
	links, err := d.list(ctx, op, "profile-limitation", url.Values{"profile": {chain}})
	if err != nil {
		return err
	}
	for _, l := range links {
		if err := d.remove(ctx, op, "profile-limitation", l[".id"]); err != nil {
			return err
		}
	}
	if err := d.remove(ctx, op, "profile", chain); err != nil {
		return err
	}
	return d.remove(ctx, op, "limitation", chain)
}
