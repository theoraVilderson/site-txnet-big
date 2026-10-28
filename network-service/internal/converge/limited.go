package converge

import "network-service/internal/driver"

// enabledDiffers is a client whose enabled state is not the row's. A client
// the panel cut at its own ceiling is the ceiling working, not a drift:
// enabling it at the same ceiling makes 3x-ui restart Xray on its next pass,
// every user on the panel dropped (LIVE-1-y). Once the ceiling is raised it no
// longer reads Limited, and is enabled then.
func enabledDiffers(row DesiredConfig, client driver.RemoteClient) bool {
	return client.Enabled != row.Enabled && !(row.Enabled && client.Limited)
}
