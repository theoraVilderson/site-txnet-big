package usermanager

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"network-service/internal/driver"
)

// The reads of the user table: ListClients for a panel we provision,
// ListAccounts (source.go) for a reseller's router an import reads in place —
// both see a user under the ceiling and rate it can actually use — and
// totals, each user's lifetime total, which GetUsage reads.

// userRead is one read of every user: the rows as the router gave them, its
// profile links, and each user as a client with its ceiling and rate.
type userRead struct {
	users        []row
	userProfiles []row
	clients      []driver.RemoteClient
}

// readUsers is four requests, whatever the number of users. query names the
// fields asked of a user (nil is every one). A user's ceiling is the most
// permissive of the profiles it holds, because that is what it can use — a
// second, unlimited profile attached by hand reads as no limit, which is the
// money-hole finding (ADR-0072 rule 2), not ours hidden behind it.
func (d *Driver) readUsers(ctx context.Context, op string, query url.Values) (userRead, error) {
	users, err := d.list(ctx, op, "user", query)
	if err != nil {
		return userRead{}, err
	}
	userProfiles, err := d.list(ctx, op, "user-profile", nil)
	if err != nil {
		return userRead{}, err
	}
	held, err := d.heldLimits(ctx, op, userProfiles)
	if err != nil {
		return userRead{}, err
	}
	clients := make([]driver.RemoteClient, 0, len(users))
	for _, u := range users {
		c := driver.RemoteClient{RemoteID: u["name"], Label: u["comment"], Enabled: u["disabled"] != "true"}
		if c.DataLimitBytes, c.RateLimitBps, err = permissive(held[u["name"]]); err != nil {
			return userRead{}, driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("user %q: %w", u["name"], err))
		}
		clients = append(clients, c)
	}
	return userRead{users: users, userProfiles: userProfiles, clients: clients}, nil
}

// ListClients reads every user of a panel we provision, its password as the
// UUID: we wrote it (CreateClient), and drift matches on it.
func (d *Driver) ListClients(ctx context.Context) ([]driver.RemoteClient, error) {
	read, err := d.readUsers(ctx, "ListClients", nil)
	if err != nil {
		return nil, err
	}
	for i, u := range read.users {
		read.clients[i].UUID = u["password"]
	}
	return read.clients, nil
}

// heldLimits is every limitation each user can use, by user name: those of
// the profiles it holds that have not ended. Two requests.
func (d *Driver) heldLimits(ctx context.Context, op string, userProfiles []row) (map[string][]row, error) {
	profileLimitations, err := d.list(ctx, op, "profile-limitation", nil)
	if err != nil {
		return nil, err
	}
	limitations, err := d.list(ctx, op, "limitation", nil)
	if err != nil {
		return nil, err
	}
	byName := map[string]row{}
	for _, l := range limitations {
		byName[l["name"]] = l
	}
	limitsOf := map[string][]row{}
	for _, pl := range profileLimitations {
		if l, ok := byName[pl["limitation"]]; ok {
			limitsOf[pl["profile"]] = append(limitsOf[pl["profile"]], l)
		}
	}
	held := map[string][]row{}
	for _, up := range userProfiles {
		if up["state"] != "used" { // a used profile has ended and grants nothing
			held[up["user"]] = append(held[up["user"]], limitsOf[up["profile"]]...)
		}
	}
	return held, nil
}

// permissive is the largest ceiling and rate among limitations, where any one
// without a figure (0) makes the answer 0: no limit.
func permissive(limits []row) (ceilingBytes, rateBps int64, err error) {
	if len(limits) == 0 {
		return 0, 0, nil
	}
	ceilingUnbounded, rateUnbounded := false, false
	for _, l := range limits {
		c, err := quantity(l["transfer-limit"], 1024)
		if err != nil {
			return 0, 0, fmt.Errorf("transfer-limit %q: %w", l["transfer-limit"], err)
		}
		if c == 0 {
			ceilingUnbounded = true
		} else if c > ceilingBytes {
			ceilingBytes = c
		}
		for _, field := range []string{"rate-limit-rx", "rate-limit-tx"} {
			r, err := quantity(l[field], 1000)
			if err != nil {
				return 0, 0, fmt.Errorf("%s %q: %w", field, l[field], err)
			}
			if r == 0 {
				rateUnbounded = true
			} else if r > rateBps {
				rateBps = r
			}
		}
	}
	if ceilingUnbounded {
		ceilingBytes = 0
	}
	if rateUnbounded {
		rateBps = 0
	}
	return ceilingBytes, rateBps, nil
}

// totals is GetUsage: User Manager's own lifetime total for every user, or
// for the named ones, with the link its limit counts from, in three requests
// whatever their number: the users' ids, one `monitor ... once` over them,
// and the profile links (F-027-ag-b, F-027-du-b). `numbers` takes row ids,
// never names — a name is a 404 on a real router — and the answer comes back
// in the order asked (both proved on a CHR, F-1601-e). Ids are listed first
// because an unknown one fails the whole command, and a user deleted on the
// router must not stop every other user being read. The total restarts with
// the user, which is a reset to the normaliser. `transfer-limit` counts from
// the profile link instead (rule 9), so each reading names our link's `.id`
// as its LimitOrigin: a link made again has a new one.
func (d *Driver) totals(ctx context.Context, op string, want map[string]bool) ([]driver.ClientUsage, error) {
	users, err := d.list(ctx, op, "user", url.Values{".proplist": {".id,name"}})
	if err != nil {
		return nil, err
	}
	var names, ids []string
	for _, u := range users {
		if want == nil || want[u["name"]] {
			names, ids = append(names, u["name"]), append(ids, u[".id"])
		}
	}
	if len(ids) == 0 {
		return nil, nil
	}
	// The monitor and the links are the read's second and third requests:
	// each pays the panel's budget as a page does (ADR-0081).
	if err := driver.NextPage(ctx, op); err != nil {
		return nil, err
	}
	var answers []row
	body := row{"numbers": strings.Join(ids, ","), "once": "", ".proplist": "total-upload,total-download"}
	if err := d.call(ctx, op, http.MethodPost, []string{"user", "monitor"}, nil, body, &answers); err != nil {
		return nil, err
	}
	if len(answers) != len(names) {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0,
			fmt.Errorf("monitor answered %d users for %d asked", len(answers), len(names)))
	}
	links, err := d.ourLinks(ctx, op)
	if err != nil {
		return nil, err
	}
	at := time.Now()
	out := make([]driver.ClientUsage, len(names))
	for i, a := range answers {
		up, errUp := quantity(a["total-upload"], 1024)
		down, errDown := quantity(a["total-download"], 1024)
		if err := errors.Join(errUp, errDown); err != nil {
			return nil, driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("user %q: %w", names[i], err))
		}
		out[i] = driver.ClientUsage{RemoteID: names[i], UpBytes: up, DownBytes: down, ObservedAt: at, LimitOrigin: links[names[i]]}
	}
	return out, nil
}

// ourLinks is each user's link to its own chain's profile, by user name: the
// row `transfer-limit` counts from. A user with none — not ours, or a chain
// half made — has no entry.
func (d *Driver) ourLinks(ctx context.Context, op string) (map[string]string, error) {
	if err := driver.NextPage(ctx, op); err != nil {
		return nil, err
	}
	rows, err := d.list(ctx, op, "user-profile", url.Values{".proplist": {".id,user,profile"}})
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, l := range rows {
		if l["profile"] == chainName(l["user"]) {
			out[l["user"]] = l[".id"]
		}
	}
	return out, nil
}
