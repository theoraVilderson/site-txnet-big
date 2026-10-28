package fake

// CutAtLimit is an x-ui panel's own depletion job: a client whose counter
// reached its ceiling is switched off by the panel, not by us (LIVE-1-y).
// ListClients then reads it Limited, as the x-ui drivers do.
func (p *Panel) CutAtLimit(remoteID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if c := p.clients[remoteID]; c != nil && atLimit(c) {
		c.enabled = false
	}
}

func atLimit(c *client) bool { return c.dataLimit > 0 && c.up+c.down >= c.dataLimit }
