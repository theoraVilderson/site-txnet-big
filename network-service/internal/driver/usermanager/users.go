package usermanager

import (
	"context"
	"fmt"
	"net/url"

	"network-service/internal/driver"
)

// The two reads of the user table: ListClients for a panel we provision, and
// ListAccounts (source.go) for a reseller's router an import reads in place.
// Both see a user under the ceiling and rate it can actually use.

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
