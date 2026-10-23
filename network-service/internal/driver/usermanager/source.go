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

// noEnd is the end-time of a profile of unlimited validity (a v7.24 CHR,
// F-1601-e): no end, never a date to parse.
const noEnd = "unlimited"

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
		if end := p["end-time"]; end != "" && end != noEnd && p["state"] != "waiting" {
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

// AccountUsage is what each user's current profile counts (F-1601-f): the
// import's "used". REST reports no per-link count (contract.usermanager.md
// rule 9), so it is rebuilt from sessions: those open, or ended after the
// user's boundary — the end of its last used link other than the current
// one — capped at the lifetime total. A user with no boundary, or any date
// that does not parse, keeps the lifetime total: more than the profile
// counts, the safe side. Five requests, or four when no user was renewed.
func (d *Driver) AccountUsage(ctx context.Context) ([]driver.ClientUsage, error) {
	const op = "AccountUsage"
	lifetime, err := d.totals(ctx, op, nil)
	if err != nil {
		return nil, err
	}
	if err := driver.NextPage(ctx, op); err != nil {
		return nil, err
	}
	links, err := d.list(ctx, op, "user-profile", url.Values{".proplist": {".id,user,state,end-time"}})
	if err != nil {
		return nil, err
	}
	since := boundaries(links)
	if len(since) == 0 {
		return lifetime, nil
	}
	if err := driver.NextPage(ctx, op); err != nil {
		return nil, err
	}
	sessions, err := d.list(ctx, op, "session", url.Values{".proplist": {"user,upload,download,ended,active"}})
	if err != nil {
		return nil, err
	}
	counted := sinceBoundaries(sessions, since)
	for i := range lifetime {
		u := &lifetime[i]
		if c, ok := counted[u.RemoteID]; ok && !c.doubt {
			u.UpBytes, u.DownBytes = min(u.UpBytes, c.up), min(u.DownBytes, c.down)
		}
	}
	return lifetime, nil
}

// boundary is the instant a user's current profile started counting, or
// doubt when a date on the way did not parse.
type boundary struct {
	at    time.Time
	doubt bool
}

// boundaries is each user's latest used-link end, the current link left out.
// Both dates compared are router-local, so one zone keeps their order and the
// router's clock is not asked for.
func boundaries(links []row) map[string]boundary {
	current := currentProfiles(links)
	out := map[string]boundary{}
	for _, l := range links {
		user, end := l["user"], l["end-time"]
		if l["state"] != "used" || l[".id"] == current[user][".id"] || end == "" || end == noEnd {
			continue
		}
		at, err := parseEnd(end, time.UTC)
		have := out[user]
		if err != nil || have.doubt {
			out[user] = boundary{doubt: true}
		} else if at.After(have.at) {
			out[user] = boundary{at: at}
		}
	}
	return out
}

// counted is one user's sessions since its boundary.
type counted struct {
	up, down int64
	doubt    bool
}

// sinceBoundaries sums, per user with a boundary, its sessions open or ended
// at or after it. Every such user has an entry, so none counted reads zero.
func sinceBoundaries(sessions []row, since map[string]boundary) map[string]counted {
	out := make(map[string]counted, len(since))
	for user, b := range since {
		out[user] = counted{doubt: b.doubt}
	}
	for _, s := range sessions {
		c, ok := out[s["user"]]
		if !ok || c.doubt {
			continue
		}
		if s["active"] != "true" {
			ended, err := parseEnd(s["ended"], time.UTC)
			if err != nil {
				out[s["user"]] = counted{doubt: true}
				continue
			}
			if ended.Before(since[s["user"]].at) {
				continue
			}
		}
		up, errUp := quantity(s["upload"], 1024)
		down, errDown := quantity(s["download"], 1024)
		if errors.Join(errUp, errDown) != nil {
			out[s["user"]] = counted{doubt: true}
			continue
		}
		out[s["user"]] = counted{up: c.up + up, down: c.down + down}
	}
	return out
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
