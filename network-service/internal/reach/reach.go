// Package reach keeps our own outage from reading as a panel's (ADR-0122).
//
// A network-layer failure (`driver.Cause.NetworkLayer`) says only that
// nothing answered. That is the panel's fault only if we could reach the
// world without it, so the Gate holds every such failure until its pass
// ends, then rules on our reach once for the whole pass:
//
//   - **probes**: every TCP probe failing is our egress down; the DNS probe
//     failing is our resolver down, which is ours for `dns_failed` alone;
//   - **mass**: at least MassMinHosts distinct hosts asked and MassShare of
//     them failing at the network layer is `suspect` — two hundred providers
//     do not fail in the same minute by coincidence. Counted by host, so six
//     panels on one dead server are one server down, not our outage.
//
// A failure ruled ours is **frozen**: never forwarded, so the panel's state,
// cause and count stay where they were and its check is not stamped. An
// answer — a 401, a 502 — is the panel's at once and costs no probe.
//
// Every pass ends in a heartbeat (`network.collector_heartbeat`), with the
// ruling, so a reader tells a live collector from a dead one and a frozen
// panel from a healthy one.
package reach

import (
	"context"
	"log/slog"
	"net"
	"sync"
	"time"

	"network-service/internal/driver"
)

// Health is what the Gate wraps — `panelstate.Tracker`, the same interface
// the collect loop holds (`collect.PanelHealth`).
type Health interface {
	Ask(panelID string, at time.Time) bool
	Observe(ctx context.Context, panelID string, err error, at time.Time) error
}

// Egress is the pass's ruling on our own reach, `network.CollectorEgress`.
type Egress string

const (
	EgressOK Egress = "ok"
	// EgressDown: no TCP probe connected.
	EgressDown Egress = "down"
	// EgressDNSDown: our resolver failed; `dns_failed` is ours.
	EgressDNSDown Egress = "dns_down"
	// EgressSuspect: the probes are up and a mass failure is still ours.
	EgressSuspect Egress = "suspect"
)

// Probe is one check of our reach.
type Probe struct{ TCP, DNS bool }

// Prober checks our reach — `NetProber` in a running process.
type Prober interface {
	Check(ctx context.Context) Probe
}

// Beat is one pass's heartbeat.
type Beat struct {
	Instance    string
	StartedAt   time.Time
	PassAt      time.Time
	Asked       int // panels judged this pass
	Failed      int // of them, failed at the network layer
	Egress      Egress
	EgressSince time.Time
}

// Heartbeats is where a Beat is written — `PostgresHeartbeats`.
type Heartbeats interface {
	Beat(ctx context.Context, b Beat) error
}

// PanelRef names a panel and the host it is reached at, for the mass rule.
type PanelRef struct{ ID, Host string }

// Defaults for the mass rule (ADR-0122 point 3).
const (
	DefaultMassMinHosts = 5
	DefaultMassShare    = 0.8
)

type held struct {
	err   error
	at    time.Time
	cause driver.Cause
}

// Gate is Health with our reach ruled on before a network failure is the
// panel's. BeginPass and EndPass bracket a bulk pass; a polled turn between
// passes is held into the next one, which only delays it a pass.
type Gate struct {
	Inner      Health
	Probe      Prober
	Heartbeats Heartbeats
	Instance   string
	StartedAt  time.Time
	Log        *slog.Logger
	// MassMinHosts / MassShare: zero takes the defaults.
	MassMinHosts int
	MassShare    float64

	mu          sync.Mutex
	hostOf      map[string]string
	pending     map[string]held
	asked       map[string]bool // panel ids judged this pass
	failed      map[string]bool // of them, network-layer failures
	egress      Egress
	egressSince time.Time
}

// Ask is the inner gate's: a frozen panel is still asked every pass.
func (g *Gate) Ask(panelID string, at time.Time) bool { return g.Inner.Ask(panelID, at) }

// BeginPass names the hosts the coming pass will ask.
func (g *Gate) BeginPass(panels []PanelRef) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.init()
	for _, p := range panels {
		g.hostOf[p.ID] = p.Host
	}
}

// Observe forwards an answer and holds a network-layer failure for the pass.
func (g *Gate) Observe(ctx context.Context, panelID string, err error, at time.Time) error {
	cause := driver.CauseOf(err)
	g.mu.Lock()
	g.init()
	if _, classified := driver.KindOf(err); err == nil || (classified && driver.Reached(err)) {
		g.asked[panelID] = true
	}
	if cause.NetworkLayer() {
		g.pending[panelID] = held{err: err, at: at, cause: cause}
		g.failed[panelID] = true
		g.mu.Unlock()
		return nil
	}
	// An answer supersedes a failure held earlier in the pass.
	delete(g.pending, panelID)
	delete(g.failed, panelID)
	g.mu.Unlock()
	return g.Inner.Observe(ctx, panelID, err, at)
}

// EndPass rules on our reach, forwards what is the panels', and beats.
func (g *Gate) EndPass(ctx context.Context, at time.Time) error {
	g.mu.Lock()
	g.init()
	pending, asked, failed := g.pending, len(g.asked), len(g.failed)
	askedHosts, failedHosts := g.hosts(g.asked), g.hosts(g.failed)
	g.pending, g.asked, g.failed = map[string]held{}, map[string]bool{}, map[string]bool{}
	g.mu.Unlock()

	egress := EgressOK
	if len(pending) > 0 {
		probe := g.Probe.Check(ctx)
		switch {
		case !probe.TCP:
			egress = EgressDown
		case askedHosts >= g.massMinHosts() && float64(failedHosts) >= g.massShare()*float64(askedHosts):
			egress = EgressSuspect
		case !probe.DNS:
			egress = EgressDNSDown
		}
	}

	frozen := 0
	var firstErr error
	for id, h := range pending {
		if ours(egress, h.cause) {
			frozen++
			continue
		}
		if err := g.Inner.Observe(ctx, id, h.err, h.at); err != nil && firstErr == nil {
			firstErr = err
		}
	}

	g.mu.Lock()
	if egress != g.egress || g.egressSince.IsZero() {
		g.egress, g.egressSince = egress, at
	}
	beat := Beat{Instance: g.Instance, StartedAt: g.StartedAt, PassAt: at, Asked: asked, Failed: failed,
		Egress: g.egress, EgressSince: g.egressSince}
	g.mu.Unlock()

	if frozen > 0 {
		g.log().Warn("panels not blamed: the outage is ours", "egress", egress, "frozen", frozen,
			"hostsAsked", askedHosts, "hostsFailed", failedHosts)
	}
	if g.Heartbeats != nil {
		if err := g.Heartbeats.Beat(ctx, beat); err != nil {
			g.log().Error("collector heartbeat failed", "error", err)
		}
	}
	return firstErr
}

// ours: a network-layer failure under a ruling that it was our outage.
func ours(egress Egress, cause driver.Cause) bool {
	switch egress {
	case EgressDown, EgressSuspect:
		return true
	case EgressDNSDown:
		return cause == driver.CauseDNSFailed
	}
	return false
}

// hosts counts the distinct hosts of a set of panels; a panel with no known
// host counts as its own.
func (g *Gate) hosts(ids map[string]bool) int {
	seen := map[string]bool{}
	for id := range ids {
		h := g.hostOf[id]
		if h == "" {
			h = "panel:" + id
		}
		seen[h] = true
	}
	return len(seen)
}

func (g *Gate) init() {
	if g.hostOf == nil {
		g.hostOf = map[string]string{}
	}
	if g.pending == nil {
		g.pending = map[string]held{}
	}
	if g.asked == nil {
		g.asked = map[string]bool{}
	}
	if g.failed == nil {
		g.failed = map[string]bool{}
	}
}

func (g *Gate) massMinHosts() int {
	if g.MassMinHosts > 0 {
		return g.MassMinHosts
	}
	return DefaultMassMinHosts
}

func (g *Gate) massShare() float64 {
	if g.MassShare > 0 {
		return g.MassShare
	}
	return DefaultMassShare
}

func (g *Gate) log() *slog.Logger {
	if g.Log != nil {
		return g.Log
	}
	return slog.Default()
}

// NetProber dials TCP probes and resolves a DNS name. Any one TCP probe
// connecting is our egress up; no probes configured proves nothing either
// way and is read as up, so an unset list never freezes a panel.
type NetProber struct {
	TCP     []string // host:port
	DNSName string
	Timeout time.Duration
}

func (p NetProber) Check(ctx context.Context) Probe {
	timeout := p.Timeout
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	out := Probe{TCP: len(p.TCP) == 0, DNS: p.DNSName == ""}
	var wg sync.WaitGroup
	var mu sync.Mutex
	for _, addr := range p.TCP {
		wg.Add(1)
		go func(addr string) {
			defer wg.Done()
			var d net.Dialer
			conn, err := d.DialContext(ctx, "tcp", addr)
			if err != nil {
				return
			}
			conn.Close()
			mu.Lock()
			out.TCP = true
			mu.Unlock()
		}(addr)
	}
	if p.DNSName != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if addrs, err := net.DefaultResolver.LookupHost(ctx, p.DNSName); err == nil && len(addrs) > 0 {
				mu.Lock()
				out.DNS = true
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return out
}
