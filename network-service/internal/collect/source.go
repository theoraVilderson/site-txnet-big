package collect

import (
	"context"
	"fmt"
	"log/slog"
	"net/netip"
	"net/url"
	"sync"
	"time"

	"network-service/internal/driver"
	"network-service/internal/egress"
	"network-service/internal/panelstate"
	"network-service/internal/register"
)

// The panel source over `network.panel` (F-027-bt): the panels a pass is
// offered, each with the driver it was accepted through.

// Opener builds a panel's driver from its row — `opener.Opener`, the one the
// registrar tests a pending panel with, so a panel is read by exactly the
// driver it was accepted through.
type Opener interface {
	Open(ctx context.Context, p register.Pending) (driver.Driver, error)
}

// StateRestorer is told what `panel.panelState` already holds —
// `panelstate.Tracker.Restore`, so a ban written before a restart is still a
// ban after it (`contract.budget.md`).
type StateRestorer interface {
	Restore(panelID string, rec panelstate.Record)
}

// DefaultReopenAfter is how long an opened driver is kept. Every open is a
// login read through the vault, audited, so opening on every pass is two
// hundred audited reads a minute; never reopening is a re-submitted login
// that is never used. Fifteen minutes is the same wait a refusal gets.
const DefaultReopenAfter = panelstate.DefaultCooloff

// PostgresSource is Source over `network.panel`. It offers the accepted
// panels, each with its driver, its request budget and its configs, and it
// reloads the cursors for them in the same breath (`PostgresCursors.reload`).
//
// A push panel is offered too (F-027-du), for its plan and its convergence:
// the RADIUS receiver is still its collector, and its turn reads the
// receiver's totals (`PostgresCursors.Totals`), not the router. A pull panel that
// declares session counters has no reading either path could give, and is
// not offered.
type PostgresSource struct {
	DB      DB
	Opener  Opener
	Cursors *PostgresCursors
	// States is told each panel's stored state before the pass asks it. Nil
	// restores nothing.
	States StateRestorer
	// ReopenAfter bounds how long a driver is kept (DefaultReopenAfter).
	ReopenAfter time.Duration
	// OpenTimeout bounds one open, which is a vault read over HTTP
	// (DefaultPanelTimeout).
	OpenTimeout time.Duration
	Clock       func() time.Time
	Log         *slog.Logger

	mu      sync.Mutex
	drivers map[string]opened
	offered []Panel
	// pins is each name-addressed panel's pin (F-027-ez), one per panel for
	// as long as it is offered: its driver dials it, its turn sets it.
	pins map[string]*egress.Pin
}

// opened is one panel's driver and the row it was built from. A row that
// changed — a new address, a new budget, a new login reference — is a driver
// built again, never one kept under the old figures.
type opened struct {
	row    panelRow
	driver driver.Driver
	at     time.Time
}

// panelRow is the part of a panel row the driver is built from.
type panelRow struct {
	register.Pending
	perMinute int
}

var _ Source = (*PostgresSource)(nil)

const panelsSQL = `
SELECT id::text, "driverType"::text, "counterSemantics"::text,
       coalesce("apiBaseUrl", ''), coalesce("clientBaseUrl", ''), "panelApiCredentials",
       "reviewState"::text, "ownershipType"::text, coalesce("tenantId"::text, ''),
       coalesce("maxLineRateBps", 0)::bigint, "maxRequestsPerMinute",
       "panelState"::text, "blockedSince",
       coalesce("panelStateCause"::text, ''), "panelStateSince",
       coalesce("lagMeanSec", 0), coalesce("lagVarianceSec2", 0), "lagSamples",
       transport::text,
       coalesce(capabilities #>> '{answers,per_client_rate_limit,supported}' = 'true', false),
       coalesce(capabilities #>> '{answers,per_client_ip_limit,supported}' = 'true', false),
       coalesce("anchorTag", ''), coalesce("anchorUuid", ''), coalesce("anchorRemoteId", ''),
       "knownAddresses", "addressMayMove"
  FROM network.panel
 WHERE "reviewState" IN ('accepted', 'accepted_low_trust')
   AND (transport = 'push' OR "counterSemantics" <> 'session')
   AND "retiredAt" IS NULL
 ORDER BY id`

func (s *PostgresSource) Panels(ctx context.Context) ([]Panel, error) {
	rows, err := s.DB.Query(ctx, panelsSQL)
	if err != nil {
		return nil, fmt.Errorf("reading panels: %w", err)
	}
	var panels []Panel
	var built []panelRow
	for rows.Next() {
		var p Panel
		var row panelRow
		var family, semantics, review, state, transport string
		var blockedSince, stateSince *time.Time
		var cause string
		var known []string
		if err := rows.Scan(&p.ID, &family, &semantics,
			&row.APIBaseURL, &row.ClientBaseURL, &row.Credentials,
			&review, &p.OwnershipType, &p.TenantID,
			&p.MaxLineRateBps, &p.MaxRequestsPerMinute, &state, &blockedSince, &cause, &stateSince,
			&p.LagMeanSec, &p.LagVarianceSec2, &p.LagSamples, &transport, &p.RateLimitable, &p.IPLimitable,
			&p.Anchor.Tag, &p.Anchor.UUID, &p.Anchor.RemoteID, &known, &p.Address.MayMove); err != nil {
			rows.Close()
			return nil, fmt.Errorf("reading panels: %w", err)
		}
		p.CounterSemantics = driver.CounterSemantics(semantics)
		p.DriverType = driver.DriverType(family)
		p.Transport = driver.Transport(transport)
		p.ReviewState = driver.ReviewState(review)
		row.PanelID, row.DriverType, row.Transport, row.CounterSemantics = p.ID, driver.DriverType(family), p.Transport, p.CounterSemantics
		row.TenantID = p.TenantID
		if u, err := url.Parse(row.APIBaseURL); err == nil {
			p.Host = u.Hostname()
		}
		p.Address.Known = ParseAddrs(known)
		p.Address.Pin = s.pinFor(p.ID, p.Host)
		row.Pin = p.Address.Pin
		row.perMinute = p.MaxRequestsPerMinute
		if s.States != nil {
			rec := panelstate.Record{State: panelstate.State(state), Cause: driver.Cause(cause)}
			if blockedSince != nil {
				rec.BlockedSince = *blockedSince
			}
			if stateSince != nil {
				rec.Since = *stateSince
			}
			s.States.Restore(p.ID, rec)
		}
		panels, built = append(panels, p), append(built, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading panels: %w", err)
	}

	ids := make([]string, len(panels))
	for i, p := range panels {
		ids[i] = p.ID
	}
	configs, err := s.Cursors.reload(ctx, ids)
	if err != nil {
		return nil, err
	}

	offered := panels[:0]
	for i, p := range panels {
		d, err := s.driverFor(ctx, built[i])
		if err != nil {
			// One panel the vault will not open is not a pass that stops. It
			// is left out, so it is never stamped, and it ages into the
			// watchdog's alert (F-027-w) rather than into a silent gap.
			s.log().Error("panel could not be opened for collection", "panel", p.ID, "error", err)
			continue
		}
		p.Driver = d
		p.Configs = configs[p.ID]
		offered = append(offered, p)
	}
	if len(offered) == 0 && len(panels) > 0 {
		// Not one listed panel opened: the vault, not the panels, is down. That
		// is a failed read, not an empty fleet, and the last good list stays
		// offered to the waker and the hot loop (LIVE-1-t).
		return nil, fmt.Errorf("opening panels: none of the %d listed could be opened", len(panels))
	}
	s.forgetExcept(ids)
	s.mu.Lock()
	s.offered = append([]Panel(nil), offered...)
	s.mu.Unlock()
	return offered, nil
}

// Offered is the panels the last pass was given, with their drivers — what
// the hot loop reads through (F-027-bu), so a panel has one driver and one
// request budget whichever loop is asking. A panel the bulk pass has not
// offered yet is not read early by anyone.
func (s *PostgresSource) Offered() []Panel {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Panel(nil), s.offered...)
}

// driverFor is the panel's driver, opened once and kept until its row changes
// or it is DefaultReopenAfter old. The kept driver is the paced one, so the
// request budget remembers the previous pass: a pace built fresh every pass
// is a budget that forgets what it spent (invariant 34).
func (s *PostgresSource) driverFor(ctx context.Context, row panelRow) (driver.Driver, error) {
	now := s.now()
	s.mu.Lock()
	kept, ok := s.drivers[row.PanelID]
	s.mu.Unlock()
	if ok && kept.row == row && now.Sub(kept.at) < s.reopenAfter() {
		return kept.driver, nil
	}

	openCtx, cancel := context.WithTimeout(ctx, s.openTimeout())
	defer cancel()
	d, err := s.Opener.Open(openCtx, row.Pending)
	if err != nil {
		return nil, err
	}
	var prev driver.Driver
	if ok {
		prev = kept.driver
	}
	paced := Repaced(Panel{Driver: d, MaxRequestsPerMinute: row.perMinute}, prev).Driver

	s.mu.Lock()
	if s.drivers == nil {
		s.drivers = map[string]opened{}
	}
	s.drivers[row.PanelID] = opened{row: row, driver: paced, at: now}
	s.mu.Unlock()
	return paced, nil
}

// forgetExcept drops the drivers of panels no longer offered — withdrawn,
// refused, deleted — so nothing keeps a login for a panel we stopped reading.
func (s *PostgresSource) forgetExcept(ids []string) {
	keep := make(map[string]bool, len(ids))
	for _, id := range ids {
		keep[id] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range s.drivers {
		if !keep[id] {
			delete(s.drivers, id)
		}
	}
	for id := range s.pins {
		if !keep[id] {
			delete(s.pins, id)
		}
	}
}

// pinFor is the panel's pin, the same one every pass, so its kept driver
// follows each turn's check; nil for a host that is an address, or none.
func (s *PostgresSource) pinFor(panelID, host string) *egress.Pin {
	if _, err := netip.ParseAddr(host); host == "" || err == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pins == nil {
		s.pins = map[string]*egress.Pin{}
	}
	pin, ok := s.pins[panelID]
	if !ok {
		pin = egress.NewPin()
		s.pins[panelID] = pin
	}
	return pin
}

func (s *PostgresSource) reopenAfter() time.Duration {
	if s.ReopenAfter > 0 {
		return s.ReopenAfter
	}
	return DefaultReopenAfter
}

func (s *PostgresSource) openTimeout() time.Duration {
	if s.OpenTimeout > 0 {
		return s.OpenTimeout
	}
	return DefaultPanelTimeout
}

func (s *PostgresSource) now() time.Time {
	if s.Clock != nil {
		return s.Clock().UTC()
	}
	return time.Now().UTC()
}

func (s *PostgresSource) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}
