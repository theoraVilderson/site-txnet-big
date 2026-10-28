package fake

import "time"

// The scripted failures a test puts on the fake panel; gate serves them.

// StallNextCall makes the next call take this long before it replies. The
// stall honours the caller's context, so the same script is a slow reply under
// a generous deadline and a timeout under a tight one.
func (p *Panel) StallNextCall(d time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.nextStall = d
}

// FailNextCall makes the next call fail with this HTTP status, once.
func (p *Panel) FailNextCall(status int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.nextStatus = status
}

// FailOp makes calls to op fail with this HTTP status — the next `times` of
// them, or every one until FailOp(op, 0, 0) clears it when times is 0: a panel
// down for writes, or one client it refuses.
func (p *Panel) FailOp(op string, status, times int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.failOps == nil {
		p.failOps = map[string]opFailure{}
	}
	if status == 0 {
		delete(p.failOps, op)
		return
	}
	p.failOps[op] = opFailure{status: status, left: times}
}

// opFailure is one FailOp: its status, and the calls left (0: until cleared).
type opFailure struct {
	status, left int
}

// failing is the status this call to op fails with, if FailOp scripted one.
// Called under p.mu.
func (p *Panel) failing(op string) int {
	f, ok := p.failOps[op]
	if !ok {
		return 0
	}
	if f.left > 0 {
		if f.left--; f.left == 0 {
			delete(p.failOps, op)
		} else {
			p.failOps[op] = f
		}
	}
	return f.status
}

// FailLinks turns the panel's subscription server off, or back on: every
// ClientLinks fails as unavailable while the admin API goes on answering.
func (p *Panel) FailLinks(down bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.linksDown = down
}
