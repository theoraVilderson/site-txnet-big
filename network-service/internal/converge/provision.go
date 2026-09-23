package converge

import (
	"context"
	"log/slog"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
)

// Provisioning carries a config's desired state to the panel (F-027-z).
//
// Every action on a config — create, regenerate, enable, disable, move,
// delete — is a write to `network.config`'s desired state and nothing else:
// `desiredRemote`, `desiredEnabled`, and the `uuid` the row holds. None of them
// calls a panel. This pass is the only code that does, and it compares desired
// state **as it is now** against what the panel reports, so a top-up that
// lands during a purge rebuilds the client instead of racing the delete, and a
// half-applied change is re-applied rather than replayed (ADR-0075).
//
// The rules the ceiling pass keeps, it keeps too:
//
//   - **Nothing is confirmed by our own write.** A write that returned nil
//     moves the row to `partial`; only a later `ListClients` that shows the
//     desired state moves it to `complete`, and only that read clears a
//     deleted client's `remoteId` (invariant 15).
//   - **A client is never created without its ceiling.** The first block goes
//     in with the create, in the counter's own origin, and a config with no
//     allocation or none left is not created at all — the gap between a
//     create and a later ceiling is unpaid traffic.
//   - **One read per pass.** The `Converger` below reads the population once
//     and hands it to this pass and to the ceiling pass.
//
// What is not here: which config a client belongs to beyond `remoteId`, and
// what a client that vanished from under a present config means — both are
// the drift comparison's (F-027-aa). A create is not repeated over a client
// already holding our `uuid`, because a create whose answer was lost is the
// commonest way to make one.

// EnforcementState is `network.EnforcementState`: how far the loop got.
type EnforcementState string

const (
	// StatePending: desired state changed and nothing has been sent since.
	StatePending EnforcementState = "pending"
	// StatePartial: a write was accepted and no read has confirmed it yet.
	StatePartial EnforcementState = "partial"
	// StateComplete: the panel was read holding exactly the desired state.
	StateComplete EnforcementState = "complete"
)

// DesiredConfig is one config's desired state on one panel, as the row holds
// it now.
type DesiredConfig struct {
	ConfigID string
	// RemoteID is the panel's id for the client, empty where none has been
	// created or the last one was confirmed deleted.
	RemoteID string
	ClaimTag string
	// UUID is the credential the client must carry. A regenerate writes a new
	// one here and nothing else; the pass carries it.
	UUID     string
	Protocol string
	// Enabled is `desiredEnabled`; Present is `desiredRemote = present`.
	Enabled bool
	Present bool
	// AllocatedBytes is `allocatedCeilingBytes`, nil until the allocator has
	// given the config a share. ServedBytes is what it has carried in its
	// lifetime — both in the allocation's basis, so a rebuilt client's first
	// ceiling is what is left, not the whole share again.
	AllocatedBytes *int64
	ServedBytes    int64
	State          EnforcementState
}

// Outcome is what the pass learned about one row. RemoteID is the value the
// row should now hold, empty to clear it.
type Outcome struct {
	ConfigID string
	RemoteID string
	State    EnforcementState
	At       time.Time
}

// Desired is `network.config`'s desired state behind an interface, as
// `Allocations` is.
type Desired interface {
	For(ctx context.Context, panelID string) ([]DesiredConfig, error)
	Record(ctx context.Context, rows []Outcome) error
}

// Action names what the pass did about one config, and each is a different
// thing to do about it.
type Action string

const (
	ActionCreated           Action = "created"
	ActionAdopted           Action = "adopted"
	ActionCredentialRotated Action = "credential_rotated"
	ActionEnabled           Action = "enabled"
	ActionDisabled          Action = "disabled"
	ActionDeleted           Action = "deleted"
	// ActionAwaitingAllocation: present, no client, and no share yet. Created
	// on the pass after the allocator writes one.
	ActionAwaitingAllocation Action = "awaiting_allocation"
	// ActionAllowanceExhausted: present, no client, and the share is spent. A
	// client created under a zero ceiling reads back as "no limit".
	ActionAllowanceExhausted Action = "allowance_exhausted"
	// ActionNoInbound: the panel has no enabled inbound for the protocol.
	ActionNoInbound Action = "no_inbound"
	// ActionRefused: the panel would not take the write. Err is a *driver.Fault.
	ActionRefused Action = "write_refused"
)

// ProvisionFinding is one config the pass did something about, or could not.
type ProvisionFinding struct {
	ConfigID string
	RemoteID string
	Action   Action
	Err      error
}

// ProvisionReport is one panel's provisioning. Removed names the clients this
// pass deleted, so the ceiling pass after it does not write to them.
type ProvisionReport struct {
	PanelID  string
	Checked  int
	Synced   int
	Written  int
	Skipped  int
	Failed   int
	Findings []ProvisionFinding
	Removed  map[string]bool
}

// Provisioning converges one panel's desired state per call. It holds no state
// of its own.
type Provisioning struct {
	Desired Desired
	Log     *slog.Logger
}

// PassOver converges every config on one panel against a population already
// read. It returns an error only where the rows could not be read or written
// back; one client the panel refuses is a finding.
func (v *Provisioning) PassOver(ctx context.Context, p collect.Panel, clients []driver.RemoteClient, at time.Time) (ProvisionReport, error) {
	report := ProvisionReport{PanelID: p.ID, Removed: map[string]bool{}}

	rows, err := v.Desired.For(ctx, p.ID)
	if err != nil || len(rows) == 0 {
		return report, err
	}

	byRemote := make(map[string]driver.RemoteClient, len(clients))
	byUUID := make(map[string]driver.RemoteClient, len(clients))
	for _, c := range clients {
		byRemote[c.RemoteID] = c
		if c.UUID != "" {
			byUUID[c.UUID] = c
		}
	}

	inbounds := &inboundCache{driver: p.Driver}
	var outcomes []Outcome
	for _, row := range rows {
		report.Checked++
		outcome, finding := v.one(ctx, p, row, byRemote, byUUID, inbounds, at, &report)
		if finding != nil {
			report.Findings = append(report.Findings, *finding)
		}
		if outcome != nil && (outcome.State != row.State || outcome.RemoteID != row.RemoteID) {
			outcomes = append(outcomes, *outcome)
		}
	}

	if len(outcomes) > 0 {
		if err := v.Desired.Record(ctx, outcomes); err != nil {
			return report, err
		}
	}
	return report, nil
}

// one decides a single row. The branches are in the order the desired state
// is read: whether the client should exist, then which client it is, then
// what it should carry.
func (v *Provisioning) one(
	ctx context.Context, p collect.Panel, row DesiredConfig,
	byRemote, byUUID map[string]driver.RemoteClient, inbounds *inboundCache,
	at time.Time, report *ProvisionReport,
) (*Outcome, *ProvisionFinding) {
	outcome := func(remoteID string, state EnforcementState) *Outcome {
		return &Outcome{ConfigID: row.ConfigID, RemoteID: remoteID, State: state, At: at}
	}
	found := func(action Action, remoteID string, err error) *ProvisionFinding {
		return &ProvisionFinding{ConfigID: row.ConfigID, RemoteID: remoteID, Action: action, Err: err}
	}
	refused := func(remoteID string, err error) (*Outcome, *ProvisionFinding) {
		report.Failed++
		return nil, found(ActionRefused, remoteID, err)
	}

	client, onPanel := byRemote[row.RemoteID]
	onPanel = onPanel && row.RemoteID != ""

	if !row.Present {
		if !onPanel {
			// Gone, by our delete or anyone's. The read is the confirmation,
			// and it is the only thing that clears the id.
			report.Synced++
			return outcome("", StateComplete), nil
		}
		if err := p.Driver.DeleteClient(ctx, row.RemoteID); err != nil {
			return refused(row.RemoteID, err)
		}
		report.Written++
		report.Removed[row.RemoteID] = true
		return outcome(row.RemoteID, StatePartial), found(ActionDeleted, row.RemoteID, nil)
	}

	if row.RemoteID != "" && !onPanel {
		// Ours, and not there. Recreating it blind would double the seat if it
		// was renamed; the verdict is the drift comparison's (F-027-aa).
		report.Skipped++
		return nil, nil
	}

	if row.RemoteID == "" {
		if existing, ok := byUUID[row.UUID]; ok && row.UUID != "" {
			// A create whose answer never reached us. Adopting it is the
			// difference between one seat and two.
			report.Written++
			return outcome(existing.RemoteID, StatePartial), found(ActionAdopted, existing.RemoteID, nil)
		}
		return v.create(ctx, p, row, inbounds, report, outcome, found, refused)
	}

	switch {
	case client.UUID != row.UUID:
		// A regenerate. The update carries the whole client as it should now
		// be; the ceiling is the one the panel holds, because sizing it is the
		// ceiling pass's and it runs next.
		err := p.Driver.UpdateClient(ctx, driver.UpdateClientRequest{
			RemoteID: row.RemoteID, ClaimTag: row.ClaimTag, UUID: row.UUID,
			InboundRemoteID: client.InboundRemoteID, DataLimitBytes: client.DataLimitBytes,
			RateLimitBps: client.RateLimitBps, ExpiresAt: client.ExpiresAt, Enabled: row.Enabled,
		})
		if err != nil {
			return refused(row.RemoteID, err)
		}
		report.Written++
		return outcome(row.RemoteID, StatePartial), found(ActionCredentialRotated, row.RemoteID, nil)
	case client.Enabled != row.Enabled:
		if err := p.Driver.SetClientEnabled(ctx, row.RemoteID, row.Enabled); err != nil {
			return refused(row.RemoteID, err)
		}
		report.Written++
		action := ActionDisabled
		if row.Enabled {
			action = ActionEnabled
		}
		return outcome(row.RemoteID, StatePartial), found(action, row.RemoteID, nil)
	default:
		report.Synced++
		return outcome(row.RemoteID, StateComplete), nil
	}
}

func (v *Provisioning) create(
	ctx context.Context, p collect.Panel, row DesiredConfig, inbounds *inboundCache, report *ProvisionReport,
	outcome func(string, EnforcementState) *Outcome,
	found func(Action, string, error) *ProvisionFinding,
	refused func(string, error) (*Outcome, *ProvisionFinding),
) (*Outcome, *ProvisionFinding) {
	if row.AllocatedBytes == nil {
		report.Skipped++
		return nil, found(ActionAwaitingAllocation, "", nil)
	}
	// A new client's counter starts at zero, so everything the config has
	// already carried is the offset.
	ceiling := PanelCeiling(*row.AllocatedBytes, row.ServedBytes)
	if ceiling == 0 {
		report.Skipped++
		return nil, found(ActionAllowanceExhausted, "", nil)
	}

	inbound, ok, err := inbounds.forProtocol(ctx, row.Protocol)
	if err != nil {
		return refused("", err)
	}
	if !ok {
		report.Skipped++
		return nil, found(ActionNoInbound, "", nil)
	}

	created, err := p.Driver.CreateClient(ctx, driver.CreateClientRequest{
		ClaimTag: row.ClaimTag, UUID: row.UUID, InboundRemoteID: inbound.RemoteID,
		Protocol: row.Protocol, DataLimitBytes: ceiling, Enabled: row.Enabled,
	})
	if err != nil {
		return refused("", err)
	}
	report.Written++
	return outcome(created.RemoteID, StatePartial), found(ActionCreated, created.RemoteID, nil)
}

// inboundCache reads the panel's inbounds at most once a pass, and only when
// something is to be created — a pass with nothing to create costs nothing.
type inboundCache struct {
	driver driver.Driver
	read   bool
	rows   []driver.Inbound
}

func (c *inboundCache) forProtocol(ctx context.Context, protocol string) (driver.Inbound, bool, error) {
	if !c.read {
		rows, err := c.driver.ListInbounds(ctx)
		if err != nil {
			return driver.Inbound{}, false, err
		}
		c.rows, c.read = rows, true
	}
	for _, inbound := range c.rows {
		if inbound.Enabled && inbound.Protocol == protocol {
			return inbound, true, nil
		}
	}
	return driver.Inbound{}, false, nil
}

// ConvergeReport is one panel's whole convergence.
type ConvergeReport struct {
	Provisioning ProvisionReport
	Ceilings     Report
}

// Converger is the pass's converger: one read of the panel's clients, then
// provisioning, then ceilings over the same read. It satisfies
// `collect.PassConverger` in place of `Ceilings`.
//
// Provisioning goes first because a disable or a delete changes what a
// ceiling means; the clients it deleted are taken out of the ceiling pass's
// population, so a stale share is never written to a client that is gone.
type Converger struct {
	Provisioning *Provisioning
	Ceilings     *Ceilings
	Log          *slog.Logger
}

func (c *Converger) Converge(ctx context.Context, p collect.Panel, res collect.Result) error {
	report, err := c.Pass(ctx, p, res)
	if err != nil {
		return err
	}
	prov, ceil := report.Provisioning, report.Ceilings
	if prov.Written > 0 || prov.Failed > 0 || ceil.Written > 0 || ceil.Failed > 0 {
		c.log().Info("panel converged",
			"panel", p.ID, "provisioned", prov.Written, "provision_failed", prov.Failed,
			"ceilings_written", ceil.Written, "ceilings_failed", ceil.Failed)
	}
	return nil
}

// Pass returns an error only where the panel could not be read or the rows
// could not be recorded.
func (c *Converger) Pass(ctx context.Context, p collect.Panel, res collect.Result) (ConvergeReport, error) {
	var report ConvergeReport
	clients, err := p.Driver.ListClients(ctx)
	if err != nil {
		return report, err
	}
	if c.Provisioning != nil {
		report.Provisioning, err = c.Provisioning.PassOver(ctx, p, clients, res.ObservedAt)
		if err != nil {
			return report, err
		}
	}
	if c.Ceilings != nil {
		remaining := clients
		if len(report.Provisioning.Removed) > 0 {
			remaining = make([]driver.RemoteClient, 0, len(clients))
			for _, client := range clients {
				if !report.Provisioning.Removed[client.RemoteID] {
					remaining = append(remaining, client)
				}
			}
		}
		report.Ceilings, err = c.Ceilings.PassOver(ctx, p, res, remaining)
	}
	return report, err
}

func (c *Converger) log() *slog.Logger {
	if c.Log != nil {
		return c.Log
	}
	return slog.Default()
}
