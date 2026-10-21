package hiddify

import (
	"context"

	"network-service/internal/driver"
)

var _ driver.SubscriptionsReader = (*Driver)(nil)

// SubscriptionURLs is every user's page under the client base url (F-203-a),
// from one user list. With no client base url the panel has none to give.
func (d *Driver) SubscriptionURLs(ctx context.Context) (map[string]string, error) {
	if d.client == nil {
		return map[string]string{}, nil
	}
	users, _, err := d.list(ctx, "SubscriptionURLs")
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(users))
	for _, u := range users {
		if u.UUID != "" {
			out[u.Name] = d.userPage(u.UUID)
		}
	}
	return out, nil
}
