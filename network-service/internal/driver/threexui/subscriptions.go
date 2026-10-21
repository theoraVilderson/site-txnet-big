package threexui

import (
	"context"
	"net/http"

	"network-service/internal/driver"
	"network-service/internal/driver/xuifamily"
)

var _ driver.SubscriptionsReader = (*Driver)(nil)

// SubscriptionURLs is every client's address the panel's own page shows
// (F-203-a): the client list and the sub server's settings, two reads for
// the whole panel. A panel with its sub server off answers none.
func (d *Driver) SubscriptionURLs(ctx context.Context) (map[string]string, error) {
	const op = "SubscriptionURLs"
	list, _, err := d.list(ctx, op)
	if err != nil {
		return nil, err
	}
	settings, err := d.subSettings(ctx, op)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(list))
	for _, r := range list {
		if r.SubID == "" {
			continue
		}
		if sub, ok := settings.Address(d.base.Hostname(), r.SubID); ok {
			out[r.Email] = sub
		}
	}
	return out, nil
}

// subSettings is the panel's sub server settings, one read.
func (d *Driver) subSettings(ctx context.Context, op string) (xuifamily.SubSettings, error) {
	var s xuifamily.SubSettings
	err := d.call(ctx, op, http.MethodPost, []string{"panel", "api", "setting", "all"}, nil, &s)
	return s, err
}
