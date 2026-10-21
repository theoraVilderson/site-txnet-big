package marzneshin

import (
	"context"

	"network-service/internal/driver"
)

var _ driver.SubscriptionsReader = (*Driver)(nil)

// SubscriptionURLs is every user's subscription_url from one user list
// (F-203-a), resolved as SubscriptionURL resolves one.
func (d *Driver) SubscriptionURLs(ctx context.Context) (map[string]string, error) {
	users, _, err := d.users(ctx, "SubscriptionURLs", nil)
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
