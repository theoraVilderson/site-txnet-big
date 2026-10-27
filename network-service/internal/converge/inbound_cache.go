package converge

import (
	"context"

	"network-service/internal/driver"
)

// inboundCache reads the panel's inbounds at most once a pass, and only when
// something is to be created or the inventory is due — a pass with neither
// costs nothing.
type inboundCache struct {
	driver driver.Driver
	read   bool
	rows   []driver.Inbound
}

func (c *inboundCache) all(ctx context.Context) ([]driver.Inbound, error) {
	if !c.read {
		rows, err := c.driver.ListInbounds(ctx)
		if err != nil {
			return nil, err
		}
		c.rows, c.read = rows, true
	}
	return c.rows, nil
}

// named is the inbound a config was placed on, if the panel still has it
// enabled and serving the config's protocol (F-114-b). No read is spent on a
// config that names none.
func (c *inboundCache) named(ctx context.Context, remoteID, protocol string) (driver.Inbound, bool, error) {
	if remoteID == "" {
		return driver.Inbound{}, false, nil
	}
	rows, err := c.all(ctx)
	if err != nil {
		return driver.Inbound{}, false, err
	}
	for _, inbound := range rows { // the id and the protocol: Marzneshin lists a service once per protocol (F-027-ba-a)
		if inbound.RemoteID == remoteID && inbound.Protocol == protocol {
			return inbound, inbound.Enabled, nil
		}
	}
	return driver.Inbound{}, false, nil
}
