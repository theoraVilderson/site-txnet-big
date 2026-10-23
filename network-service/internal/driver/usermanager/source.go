package usermanager

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"network-service/internal/driver"
)

// This file is the read an import makes of a reseller's own User Manager
// (ADR-0160, F-1601-a): its users are imported in place, each keeping its
// login on the router, so the snapshot names what each was sold (a profile),
// what it may use and until when — and never its password.

var _ driver.AccountsReader = (*Driver)(nil)

// accountFields is what the snapshot asks of a user. The password is left
// out on purpose: the router never sends it, so no secret is held here even
// for the length of a request (ADR-0160 rule 2).
const accountFields = ".id,name,comment,disabled"

// endFormats are the two shapes RouterOS writes a date in: ISO from 7.10,
// `nov/15/2026` before it. Both are the router's local time.
var endFormats = []string{"2006-01-02 15:04:05", "Jan/02/2006 15:04:05"}

// ListProfiles lists the profiles a user can be sold: what an import maps to
// a product, as an Xray import maps an inbound. A profile serves whichever
// service the NAS dials in with, so Protocol is left empty.
func (d *Driver) ListProfiles(ctx context.Context) ([]driver.Inbound, error) {
	profiles, err := d.list(ctx, "ListProfiles", "profile", url.Values{".proplist": {"name"}})
	if err != nil {
		return nil, err
	}
	out := make([]driver.Inbound, 0, len(profiles))
	for _, p := range profiles {
		out = append(out, driver.Inbound{RemoteID: p["name"], Tag: p["name"], Enabled: true})
	}
	return out, nil
}

// ListAccounts reads every user as an import needs it, in four requests (a
// fifth, the router's clock, when any profile has an end): the user, its
// current profile, the most permissive ceiling and rate it holds (as
// ListClients reads them), and that profile's end.
func (d *Driver) ListAccounts(ctx context.Context) ([]driver.RemoteClient, error) {
	const op = "ListAccounts"
	read, err := d.readUsers(ctx, op, url.Values{".proplist": {accountFields}})
	if err != nil {
		return nil, err
	}
	current := currentProfiles(read.userProfiles)
	var zone *time.Location
	for i := range read.clients {
		c := &read.clients[i]
		p := current[c.RemoteID]
		c.InboundRemoteID = p["profile"]
		if end := p["end-time"]; end != "" && p["state"] != "waiting" {
			if zone == nil {
				if zone, err = d.routerZone(ctx, op); err != nil {
					return nil, err
				}
			}
			if c.ExpiresAt, err = parseEnd(end, zone); err != nil {
				return nil, driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("user %q: %w", c.RemoteID, err))
			}
		}
	}
	return read.clients, nil
}

// currentProfiles picks the one profile each user is on: the running one,
// else the first waiting (bought, not started), else the last used — an
// expired user is still mapped, and its end in the past says so.
func currentProfiles(userProfiles []row) map[string]row {
	rank := func(state string) int {
		switch state {
		case "running", "running-active":
			return 3
		case "waiting":
			return 2
		}
		return 1
	}
	out := map[string]row{}
	for _, up := range userProfiles {
		have, ok := out[up["user"]]
		r, h := rank(up["state"]), rank(have["state"])
		// Among used profiles the later row is the more recent; among
		// waiting ones the first is the next to start.
		if !ok || r > h || (r == h && r == 1) {
			out[up["user"]] = up
		}
	}
	return out
}

// routerZone is the router's clock offset: an end-time is written in it.
func (d *Driver) routerZone(ctx context.Context, op string) (*time.Location, error) {
	var clock row
	if err := d.callAt(ctx, op, http.MethodGet, []string{"system", "clock"}, nil, nil, &clock); err != nil {
		return nil, err
	}
	offset := clock["gmt-offset"]
	sign, hm := 1, offset
	if strings.HasPrefix(offset, "-") {
		sign = -1
	}
	hm = strings.TrimLeft(hm, "+-")
	h, m, ok := strings.Cut(hm, ":")
	hours, errH := strconv.Atoi(h)
	minutes, errM := strconv.Atoi(m)
	if !ok || errors.Join(errH, errM) != nil {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("gmt-offset %q is not ±hh:mm", offset))
	}
	return time.FixedZone(offset, sign*(hours*3600+minutes*60)), nil
}

// parseEnd reads an end-time in either RouterOS date shape. One it cannot
// read fails the read: an import never guesses an end (contract.import.md rule 1).
func parseEnd(s string, zone *time.Location) (time.Time, error) {
	for _, layout := range endFormats {
		if at, err := time.ParseInLocation(layout, s, zone); err == nil {
			return at, nil
		}
	}
	return time.Time{}, fmt.Errorf("end-time %q is in no date format RouterOS writes", s)
}
