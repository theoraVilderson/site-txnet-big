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
// ClientTotals, each user's lifetime total.

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

var _ driver.TotalsReader = (*Driver)(nil)

// ClientTotals reads User Manager's own lifetime total for every user in two
// requests: the users' ids, then one `monitor ... once` over all of them
// (F-027-du). `numbers` takes row ids, never names — a name is a 404 on a
// real router — and the answer comes back in the order asked (both proved on
// a CHR, F-1601-e). Ids are listed first because an unknown one fails the
// whole command, and a user deleted on the router must not stop every other
// user being read. The total restarts with the user, which is the point: it
// shows a user made again by hand. It is not what `transfer-limit` is checked
// against — that counts from the profile link (contract.drivers.md).
func (d *Driver) ClientTotals(ctx context.Context) ([]driver.ClientUsage, error) {
	const op = "ClientTotals"
	users, err := d.list(ctx, op, "user", url.Values{".proplist": {".id,name"}})
	if err != nil || len(users) == 0 {
		return nil, err
	}
	names := make([]string, len(users))
	ids := make([]string, len(users))
	for i, u := range users {
		names[i], ids[i] = u["name"], u[".id"]
	}
	var answers []row
	body := row{"numbers": strings.Join(ids, ","), "once": ""}
	if err := d.call(ctx, op, http.MethodPost, []string{"user", "monitor"}, nil, body, &answers); err != nil {
		return nil, err
	}
	if len(answers) != len(names) {
		return nil, driver.NewFault(driver.FaultProtocol, op, 0,
			fmt.Errorf("monitor answered %d users for %d asked", len(answers), len(names)))
	}
	at := time.Now()
	out := make([]driver.ClientUsage, len(names))
	for i, a := range answers {
		up, errUp := quantity(a["total-upload"], 1024)
		down, errDown := quantity(a["total-download"], 1024)
		if err := errors.Join(errUp, errDown); err != nil {
			return nil, driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("user %q: %w", names[i], err))
		}
		out[i] = driver.ClientUsage{RemoteID: names[i], UpBytes: up, DownBytes: down, ObservedAt: at}
	}
	return out, nil
}
