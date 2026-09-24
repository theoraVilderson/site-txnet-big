// Package fake is a scripted panel: a behaviour model of the far end, not a
// mock of our own calls (F-027-j, ADR-0074).
//
// It exists because a wrong declaration is a silent wrong number. Every part
// of the pipeline above the driver — the normaliser's three arithmetics, the
// reset detection, the plausibility cap, the ceiling and its convergence — has
// to be built and proved against a source that actually does the things a real
// panel does: reset its counter, come back from a backup, stall past a
// deadline, wrap at 32 bits, omit Gigawords, leave a session without a Stop,
// refuse a ceiling and apply one late. Owning six families of server to find
// that out is not a plan, and finding it out in production is the failure
// ADR-0074 was written to avoid.
//
// The fake answers the acceptance questionnaire from what it will actually do,
// so its Capabilities document is an observation like a real panel's and not a
// setting. A row switched off in Config changes behaviour, in the same place a
// real family's gap would.
package fake

import (
	"context"
	"fmt"
	"sync"
	"time"

	"network-service/internal/driver"
)

// wrapAt is where a 32-bit octet counter rolls over. A NAS that does not send
// Acct-Input-Gigawords loses everything above it, in silence, which is the
// whole reason the questionnaire has a row for it (invariant 29).
const wrapAt = int64(1) << 32

// Config is the panel to build. Every in-scope questionnaire row is supported
// unless named in Unsupported: a fake that fails nothing proves nothing, but
// one that fails by default hides which gap a test is actually about.
type Config struct {
	Transport        driver.Transport
	CounterSemantics driver.CounterSemantics
	// Unsupported switches a row off. Rows outside this transport's scope are
	// ignored rather than refused — they are not asked at all.
	Unsupported map[driver.RowKey]bool
}

type client struct {
	remoteID  string
	label     string
	uuid      string
	inbound   string
	enabled   bool
	rateLimit int64
	expiresAt time.Time

	// up and down are the far end's own counters, in full precision. What a
	// read reports is derived from them: truncated to 32 bits without
	// Gigawords, zeroed by the read under reset_on_read.
	up, down int64
	// sessionID is set only under session semantics. It is what makes a
	// restored backup harmless: the restore brings back an id already closed.
	sessionID string
	// abandoned is the session whose NAS never sent a Stop. It keeps being
	// reported at its last observed figure and never rises again.
	abandoned bool

	// dataLimit is the ceiling the panel is enforcing now; pending is one
	// written but not yet taken, and pendingReads is how many reads away it is.
	dataLimit    int64
	pending      int64
	pendingReads int
}

// Panel is one scripted panel and its driver at once: the control surface
// below (Given, Serve, FailNextCall…) is the far end, and the Driver methods
// are what our code sees. A real family splits the two — a driver over a
// scripted HTTP server — and the conformance suite is written to the split.
type Panel struct {
	cfg Config

	mu       sync.Mutex
	clients  map[string]*client
	order    []string
	backup   map[string]client
	sessions int
	created  int

	nextStall  time.Duration
	nextStatus int
	// ceilingDelay is consumed by the next ceiling write.
	ceilingDelay int

	calls map[string]int
}

var _ driver.Driver = (*Panel)(nil)

// New builds a panel with no clients on it.
func New(cfg Config) *Panel {
	if cfg.Transport == "" {
		cfg.Transport = driver.TransportPull
	}
	if cfg.CounterSemantics == "" {
		cfg.CounterSemantics = driver.CounterCumulative
	}
	return &Panel{cfg: cfg, clients: map[string]*client{}, calls: map[string]int{}}
}

// Driver satisfies the conformance harness. The fake is both halves at once —
// the far end and the driver over it — where a real family is a driver and a
// scripted HTTP server of its own (F-027-ae). The suite is written to the
// split, so nothing in it reaches past this method.
func (p *Panel) Driver() driver.Driver { return p }

func (p *Panel) supports(key driver.RowKey) bool {
	row, ok := driver.RowByKey(key)
	if !ok || !row.Scope.Includes(p.cfg.Transport) {
		return false
	}
	return !p.cfg.Unsupported[key]
}

// ---- the far end -----------------------------------------------------------

// Given puts a client on the panel without going through the driver — the
// users that were already there when we were pointed at it.
func (p *Panel) Given(remoteID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.clients[remoteID]; ok {
		return
	}
	c := &client{remoteID: remoteID, uuid: remoteID, enabled: true, inbound: "inbound-1"}
	if p.cfg.CounterSemantics == driver.CounterSession {
		c.sessionID = p.newSessionLocked()
	}
	p.clients[remoteID] = c
	p.order = append(p.order, remoteID)
}

// Rename is an operator renaming a client on the panel: a new id and the same
// client — label, credential, counter and ceiling all kept. It is the drift
// the claim tag exists for (F-027-aa).
func (p *Panel) Rename(from, to string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.clients[from]
	if c == nil {
		return
	}
	delete(p.clients, from)
	c.remoteID = to
	p.clients[to] = c
	for i, id := range p.order {
		if id == from {
			p.order[i] = to
		}
	}
}

// Rebuild is a client deleted and made again by hand from its credential: a
// new id and the same uuid, and nothing else we wrote — no label, no ceiling,
// a counter from zero.
func (p *Panel) Rebuild(from, to string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	old := p.clients[from]
	if old == nil {
		return
	}
	delete(p.clients, from)
	c := &client{remoteID: to, uuid: old.uuid, inbound: old.inbound, enabled: true}
	if p.cfg.CounterSemantics == driver.CounterSession {
		c.sessionID = p.newSessionLocked()
	}
	p.clients[to] = c
	for i, id := range p.order {
		if id == from {
			p.order[i] = to
		}
	}
}

// Remove is a client deleted behind our back, by the panel's own operator.
func (p *Panel) Remove(remoteID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.clients, remoteID)
	for i, id := range p.order {
		if id == remoteID {
			p.order = append(p.order[:i], p.order[i+1:]...)
			break
		}
	}
}

// Serve moves bytes at the far end. An abandoned session reports none of them:
// that is what a missing Stop looks like from here.
func (p *Panel) Serve(remoteID string, up, down int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.clients[remoteID]
	if c == nil || c.abandoned {
		return
	}
	c.up += up
	c.down += down
}

// ZeroCounter is the far end losing its counter: a restart, an operator reset,
// or a client update on a panel whose counter does not survive one. Under
// session semantics the old session ends and a new one starts, which is the
// same event wearing the other family's clothes.
func (p *Panel) ZeroCounter(remoteID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.zeroLocked(p.clients[remoteID])
}

func (p *Panel) zeroLocked(c *client) {
	if c == nil {
		return
	}
	c.up, c.down = 0, 0
	c.abandoned = false
	if p.cfg.CounterSemantics == driver.CounterSession {
		c.sessionID = p.newSessionLocked()
	}
}

func (p *Panel) newSessionLocked() string {
	p.sessions++
	return fmt.Sprintf("session-%d", p.sessions)
}

// TakeBackup and RestoreBackup are ADR-0074's catastrophe. Session ids are
// restored with everything else — that is the point — but the id generator is
// not rolled back, so a session started after the restore can never collide
// with one the restore brought back.
func (p *Panel) TakeBackup() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.backup = make(map[string]client, len(p.clients))
	for id, c := range p.clients {
		p.backup[id] = *c
	}
}

func (p *Panel) RestoreBackup() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.backup == nil {
		return
	}
	p.clients = make(map[string]*client, len(p.backup))
	p.order = p.order[:0]
	for id, snapshot := range p.backup {
		restored := snapshot
		p.clients[id] = &restored
		p.order = append(p.order, id)
	}
}

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

// AbandonSession leaves the session open and un-updated: the NAS that never
// sent a Stop. Nothing served afterwards is reported, and the session's last
// observed figure is the most that may ever be published for it (invariant 27).
func (p *Panel) AbandonSession(remoteID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if c := p.clients[remoteID]; c != nil {
		c.abandoned = true
	}
}

// DelayCeilingBy accepts the next ceiling write and takes it this many reads
// later — the panel that says yes and means eventually.
func (p *Panel) DelayCeilingBy(reads int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ceilingDelay = reads
}

// CallCount is how many times one Driver method reached the far end. The
// request volume is a contract, not an optimisation, and this is what lets it
// be asserted (catalog 8.4, F-027-k).
func (p *Panel) CallCount(op string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls[op]
}

// TotalCalls is every request that reached the far end, whichever method made
// it. It is what the request-volume scenarios count (F-027-k): the driver's
// own opinion of how often it called is the side under test.
func (p *Panel) TotalCalls() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	total := 0
	for _, n := range p.calls {
		total += n
	}
	return total
}

// gate is every call's far end: it counts the call, serves the scripted stall
// under the caller's deadline, and turns a scripted status into the Fault a
// real driver would have classified.
func (p *Panel) gate(ctx context.Context, op string) error {
	p.mu.Lock()
	stall, status := p.nextStall, p.nextStatus
	p.nextStall, p.nextStatus = 0, 0
	p.calls[op]++
	p.mu.Unlock()

	if stall > 0 {
		timer := time.NewTimer(stall)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return driver.NewFault(driver.FaultTimeout, op, 0, ctx.Err())
		}
	}
	if err := ctx.Err(); err != nil {
		return driver.NewFault(driver.FaultTimeout, op, 0, err)
	}
	if status != 0 {
		return driver.FaultForStatus(op, status, nil)
	}
	return nil
}

func (p *Panel) unsupported(op string) error {
	return driver.NewFault(driver.FaultUnsupported, op, 0, nil)
}

func (p *Panel) notFound(op, remoteID string) error {
	return driver.NewFault(driver.FaultProtocol, op, 0, fmt.Errorf("no client %q on this panel", remoteID))
}

// ---- the driver ------------------------------------------------------------

// Capabilities answers every row this transport is asked, from what the panel
// will actually do. It is a connection test, not a setting.
func (p *Panel) Capabilities(ctx context.Context) (driver.Capabilities, error) {
	if err := p.gate(ctx, "Capabilities"); err != nil {
		return driver.Capabilities{}, err
	}
	answers := map[driver.RowKey]driver.Answer{}
	for _, row := range driver.Questionnaire() {
		if !row.Scope.Includes(p.cfg.Transport) {
			continue
		}
		supported := p.supports(row.Key)
		detail := "observed against the fake panel"
		if !supported {
			detail = "switched off in fake.Config, so this panel behaves as a family without the row"
		}
		answers[row.Key] = driver.Answer{Supported: supported, Detail: detail}
	}
	return driver.Capabilities{
		Version:    driver.CapabilitiesVersion,
		AnsweredAt: time.Now().UTC(),
		Answers:    answers,
	}, nil
}

func (p *Panel) HealthCheck(ctx context.Context) error { return p.gate(ctx, "HealthCheck") }

func (p *Panel) ListInbounds(ctx context.Context) ([]driver.Inbound, error) {
	if err := p.gate(ctx, "ListInbounds"); err != nil {
		return nil, err
	}
	return []driver.Inbound{{
		RemoteID: "inbound-1", Tag: "fake-vless", Protocol: "vless",
		Port: 443, Host: "fake.invalid", Enabled: true,
	}}, nil
}

// ListClients reports what the panel is enforcing now. A ceiling written but
// not yet taken reads as the old one until the far end takes it, and draining
// that delay is a read's side effect here exactly as it is at a real panel.
func (p *Panel) ListClients(ctx context.Context) ([]driver.RemoteClient, error) {
	if err := p.gate(ctx, "ListClients"); err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	out := make([]driver.RemoteClient, 0, len(p.order))
	for _, id := range p.order {
		c := p.clients[id]
		if c == nil {
			continue
		}
		enforcing := c.dataLimit
		if c.pendingReads > 0 {
			c.pendingReads--
			if c.pendingReads == 0 {
				c.dataLimit = c.pending
			}
		}
		out = append(out, driver.RemoteClient{
			RemoteID: c.remoteID, Label: c.label, UUID: c.uuid,
			InboundRemoteID: c.inbound, Enabled: c.enabled,
			DataLimitBytes: enforcing, RateLimitBps: c.rateLimit, ExpiresAt: c.expiresAt,
		})
	}
	return out, nil
}

func (p *Panel) CreateClient(ctx context.Context, req driver.CreateClientRequest) (driver.RemoteClient, error) {
	if err := p.gate(ctx, "CreateClient"); err != nil {
		return driver.RemoteClient{}, err
	}
	if !p.supports(driver.RowClientLifecycle) {
		return driver.RemoteClient{}, p.unsupported("CreateClient")
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	p.created++
	c := &client{
		remoteID: fmt.Sprintf("remote-%d", p.created), uuid: req.UUID,
		inbound: req.InboundRemoteID, enabled: req.Enabled,
		dataLimit: req.DataLimitBytes, rateLimit: req.RateLimitBps, expiresAt: req.ExpiresAt,
	}
	// The claim tag is the second matching key, and only where the family has
	// a field we own to put it in (F-027-aa).
	if p.supports(driver.RowClientLabelStorable) {
		c.label = req.ClaimTag
	}
	if p.cfg.CounterSemantics == driver.CounterSession {
		c.sessionID = p.newSessionLocked()
	}
	p.clients[c.remoteID] = c
	p.order = append(p.order, c.remoteID)
	return driver.RemoteClient{
		RemoteID: c.remoteID, Label: c.label, UUID: c.uuid, InboundRemoteID: c.inbound,
		Enabled: c.enabled, DataLimitBytes: c.dataLimit, RateLimitBps: c.rateLimit, ExpiresAt: c.expiresAt,
	}, nil
}

func (p *Panel) UpdateClient(ctx context.Context, req driver.UpdateClientRequest) error {
	if err := p.gate(ctx, "UpdateClient"); err != nil {
		return err
	}
	if !p.supports(driver.RowClientLifecycle) {
		return p.unsupported("UpdateClient")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.clients[req.RemoteID]
	if c == nil {
		return p.notFound("UpdateClient", req.RemoteID)
	}
	c.uuid, c.inbound, c.enabled = req.UUID, req.InboundRemoteID, req.Enabled
	c.dataLimit, c.rateLimit, c.expiresAt = req.DataLimitBytes, req.RateLimitBps, req.ExpiresAt
	if p.supports(driver.RowClientLabelStorable) {
		c.label = req.ClaimTag
	}
	p.afterWriteLocked(c)
	return nil
}

func (p *Panel) SetClientEnabled(ctx context.Context, remoteID string, enabled bool) error {
	if err := p.gate(ctx, "SetClientEnabled"); err != nil {
		return err
	}
	if !p.supports(driver.RowEnableDisableClient) {
		return p.unsupported("SetClientEnabled")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.clients[remoteID]
	if c == nil {
		return p.notFound("SetClientEnabled", remoteID)
	}
	c.enabled = enabled
	return nil
}

func (p *Panel) DeleteClient(ctx context.Context, remoteID string) error {
	if err := p.gate(ctx, "DeleteClient"); err != nil {
		return err
	}
	if !p.supports(driver.RowClientLifecycle) {
		return p.unsupported("DeleteClient")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, ok := p.clients[remoteID]; !ok {
		return p.notFound("DeleteClient", remoteID)
	}
	delete(p.clients, remoteID)
	for i, id := range p.order {
		if id == remoteID {
			p.order = append(p.order[:i], p.order[i+1:]...)
			break
		}
	}
	return nil
}

// SetClientDataLimit is the enforcement point ADR-0072 rests on. A panel
// without the row refuses it rather than accepting a ceiling it will not hold:
// a believed ceiling is worse than a missing one, because the traffic past it
// is served with nothing red anywhere.
func (p *Panel) SetClientDataLimit(ctx context.Context, remoteID string, ceilingBytes int64) error {
	if err := p.gate(ctx, "SetClientDataLimit"); err != nil {
		return err
	}
	if !p.supports(driver.RowPerClientDataLimit) {
		return p.unsupported("SetClientDataLimit")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.clients[remoteID]
	if c == nil {
		return p.notFound("SetClientDataLimit", remoteID)
	}
	if p.ceilingDelay > 0 {
		c.pending, c.pendingReads = ceilingBytes, p.ceilingDelay
		p.ceilingDelay = 0
	} else {
		c.dataLimit = ceilingBytes
	}
	p.afterWriteLocked(c)
	return nil
}

func (p *Panel) SetClientRateLimit(ctx context.Context, remoteID string, rateBps int64) error {
	if err := p.gate(ctx, "SetClientRateLimit"); err != nil {
		return err
	}
	if !p.supports(driver.RowPerClientRateLimit) {
		return p.unsupported("SetClientRateLimit")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.clients[remoteID]
	if c == nil {
		return p.notFound("SetClientRateLimit", remoteID)
	}
	c.rateLimit = rateBps
	p.afterWriteLocked(c)
	return nil
}

// afterWriteLocked is the family whose counter does not survive a client
// update: every ceiling write looks like a reset. It is a declared row, so it
// changes behaviour here rather than being a note (ADR-0074, F-027-t).
func (p *Panel) afterWriteLocked(c *client) {
	if !p.supports(driver.RowCounterSurvivesUpdate) {
		p.zeroLocked(c)
	}
}

func (p *Panel) GetUsage(ctx context.Context) ([]driver.ClientUsage, error) {
	if err := p.gate(ctx, "GetUsage"); err != nil {
		return nil, err
	}
	return p.readLocked(nil), nil
}

// GetUsageFor serves the named subset. A panel without the row still answers
// in one call, from the bulk pass — the loop reads the declared answer to
// decide what a pass costs, never the shape of this method.
func (p *Panel) GetUsageFor(ctx context.Context, remoteIDs []string) ([]driver.ClientUsage, error) {
	if err := p.gate(ctx, "GetUsageFor"); err != nil {
		return nil, err
	}
	wanted := make(map[string]bool, len(remoteIDs))
	for _, id := range remoteIDs {
		wanted[id] = true
	}
	return p.readLocked(wanted), nil
}

// readLocked turns the far end's counters into readings. Three things happen
// here and nowhere else: a NAS with no Gigawords loses everything above 4 GB,
// a reset_on_read counter is spent by being read, and a session carries the id
// that makes a restore harmless.
func (p *Panel) readLocked(wanted map[string]bool) []driver.ClientUsage {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := time.Now().UTC()
	truncate := p.cfg.Transport == driver.TransportPush && !p.supports(driver.RowGigawordsReported)

	out := make([]driver.ClientUsage, 0, len(p.order))
	for _, id := range p.order {
		c := p.clients[id]
		if c == nil || (wanted != nil && !wanted[id]) {
			continue
		}
		up, down := c.up, c.down
		if truncate {
			up, down = up%wrapAt, down%wrapAt
		}
		out = append(out, driver.ClientUsage{
			RemoteID: c.remoteID, UpBytes: up, DownBytes: down,
			ObservedAt: now, SessionID: c.sessionID,
		})
		if p.cfg.CounterSemantics == driver.CounterResetOnRead {
			c.up, c.down = 0, 0
		}
	}
	return out
}

// ResetUsage is an operator action. The collection loop never calls it: a
// reset is something we detect, never something we cause (F-027-l).
func (p *Panel) ResetUsage(ctx context.Context, remoteID string) error {
	if err := p.gate(ctx, "ResetUsage"); err != nil {
		return err
	}
	if !p.supports(driver.RowUsageResetSupported) {
		return p.unsupported("ResetUsage")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.clients[remoteID]
	if c == nil {
		return p.notFound("ResetUsage", remoteID)
	}
	p.zeroLocked(c)
	return nil
}

func (p *Panel) BuildLink(ctx context.Context, client driver.RemoteClient, inbound driver.Inbound) (string, error) {
	if err := p.gate(ctx, "BuildLink"); err != nil {
		return "", err
	}
	return fmt.Sprintf("%s://%s@%s:%d?#%s", inbound.Protocol, client.UUID, inbound.Host, inbound.Port, inbound.Tag), nil
}

// ClientLinks is one line per client, from its uuid and label; a panel that
// declares no subscription link has none to give (contract.links.md).
func (p *Panel) ClientLinks(ctx context.Context, client driver.RemoteClient) ([]string, error) {
	if err := p.gate(ctx, "ClientLinks"); err != nil {
		return nil, err
	}
	if !p.supports(driver.RowNativeSubscriptionLink) {
		return nil, nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	c := p.clients[client.RemoteID]
	if c == nil {
		return nil, p.notFound("ClientLinks", client.RemoteID)
	}
	return []string{"vless://" + c.uuid + "@fake.invalid:443#" + c.label}, nil
}

func (p *Panel) SubscriptionURL(ctx context.Context, remoteID string) (string, bool) {
	if !p.supports(driver.RowNativeSubscriptionLink) {
		return "", false
	}
	return "https://fake.invalid/sub/" + remoteID, true
}
