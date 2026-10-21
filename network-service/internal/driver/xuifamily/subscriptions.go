package xuifamily

import (
	"context"

	"network-service/internal/driver"
)

var _ driver.SubscriptionsReader = (*Driver)(nil)

// SubscriptionURLs is every client's address the panel's own page shows
// (F-203-a): the inbound list and the sub server's settings, two reads for
// the whole panel. A panel with its sub server off answers none.
func (d *Driver) SubscriptionURLs(ctx context.Context) (map[string]string, error) {
	const op = "SubscriptionURLs"
	list, _, err := d.list(ctx, op)
	if err != nil {
		return nil, err
	}
	all, err := clients(op, list)
	if err != nil {
		return nil, err
	}
	settings, err := d.subSettings(ctx, op)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(all))
	for _, f := range all {
		if f.client.SubID == "" {
			continue
		}
		if sub, ok := settings.Address(d.base.Hostname(), f.client.SubID); ok {
			out[f.client.Email] = sub
		}
	}
	return out, nil
}
