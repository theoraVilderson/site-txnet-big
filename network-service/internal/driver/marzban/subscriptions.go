package marzban

import (
	"context"
	"net/url"

	"network-service/internal/driver"
)

var _ driver.SubscriptionsReader = (*Driver)(nil)

// SubscriptionURLs is every user's subscription_url from one user list
// (F-203-a): the list carries it, so no user is read alone.
func (d *Driver) SubscriptionURLs(ctx context.Context) (map[string]string, error) {
	users, _, err := d.listUsers(ctx, "SubscriptionURLs", nil)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(users))
	for _, u := range users {
		if sub, ok := d.subscription(u); ok {
			out[u.Username] = sub
		}
	}
	return out, nil
}

// subscription resolves the user's subscription_url, which is a path unless
// the panel has XRAY_SUBSCRIPTION_URL_PREFIX set.
func (d *Driver) subscription(u user) (string, bool) {
	if u.SubscriptionURL == "" {
		return "", false
	}
	ref, err := url.Parse(u.SubscriptionURL)
	if err != nil {
		return "", false
	}
	return d.base.ResolveReference(ref).String(), true
}
