package sui

import (
	"context"

	"network-service/internal/driver"
)

var _ driver.SubscriptionsReader = (*Driver)(nil)

// SubscriptionURLs is every client's subscription (F-203-a): one load names
// them all and holds the panel's subURI, so no client is read alone.
func (d *Driver) SubscriptionURLs(ctx context.Context) (map[string]string, error) {
	ids, err := d.index(ctx, "SubscriptionURLs")
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(ids))
	for name := range ids {
		if sub, ok := d.SubscriptionURL(ctx, name); ok {
			out[name] = sub
		}
	}
	return out, nil
}
