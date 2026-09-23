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
// Which client is which config is the drift comparison's three-key match
// (drift.go, F-027-aa), and every branch below acts on the client it found,
// not on the row's `remoteId`: a renamed or rebuilt client is re-keyed and
// carried on, and a create is not repeated over a client already holding our
// tag or `uuid`, because a create whose answer was lost is the commonest way
// to make one. A `missing` client is recreated and a `rebuilt` one gets its tag
// back, and both are repairs: bounded by the anti-flap stop (drift.go,
// F-027-ab), so a config somebody keeps deleting is held `contested` instead
// of recreated every minute.

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
	// Drift is `driftState` as the row holds it; empty reads as synced.
	Drift DriftState
	// RepairCount and RepairedAt are `driftRepairCount` and
	// `driftRepairedAt`: the anti-flap stop's memory (F-027-ab).
	RepairCount int
	RepairedAt  time.Time
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
// RecordDrift is a method of its own rather than a field of Outcome because two
// passes supply the verdict: provisioning the identity ones, the ceiling pass
// `reset` and `limit_overridden` (F-027-aa). It writes the repair count with
// the verdict (F-027-ab).
type Desired interface {
	For(ctx context.Context, panelID string) ([]DesiredConfig, error)
	Record(ctx context.Context, rows []Outcome) error
	RecordDrift(ctx context.Context, rows []Verdict) error
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
	// ActionRekeyed: a renamed or rebuilt client already holds the desired
	// state; only the row's `remoteId` moved to it.
	ActionRekeyed Action = "rekeyed"
	// ActionRestored: a rebuilt client had our tag and its first block
	// written back, on the row re-keyed to it. A repair.
	ActionRestored Action = "restored"
	// ActionRecreated: a missing client was created again under the same tag
	// and credential. A repair.
	ActionRecreated Action = "recreated"
	// ActionContested: a repair was due and the stop held it. A rebuilt
	// client is still re-keyed and still gets a ceiling if it has none or a
	// higher one — the exception — but not its tag.
	ActionContested Action = "contested"
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
// pass deleted, so the ceiling pass after it does not write to them. Drift is
// every row's identity verdict, which the `Converger` completes with the
// ceiling pass's and records; Orphans are the remote ids no config claims.
// Stopped is the rows whose repair budget is spent, with the verdict each
// holds, so the ceiling pass holds its repairs too.
type ProvisionReport struct {
	PanelID  string
	Checked  int
	Synced   int
	Written  int
	Skipped  int
	Failed   int
	Findings []ProvisionFinding
	Removed  map[string]bool
	Drift    map[string]Judgement
	Orphans  []string
	Stopped  map[string]DriftState
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
	report := ProvisionReport{
		PanelID: p.ID, Removed: map[string]bool{}, Drift: map[string]Judgement{}, Stopped: map[string]DriftState{},
	}

	rows, err := v.Desired.For(ctx, p.ID)
	if err != nil {
		return report, err
	}

	matching := MatchClients(rows, clients)
	for _, orphan := range matching.Orphans {
		report.Orphans = append(report.Orphans, orphan.RemoteID)
	}

	inbounds := &inboundCache{driver: p.Driver}
	var outcomes []Outcome
	for _, row := range rows {
		report.Checked++
		match, matched := matching.ByConfig[row.ConfigID]
		stopped := repairsInWindow(row, at) >= MaxRepairs
		if stopped {
			report.Stopped[row.ConfigID] = row.Drift
		}
		judgement := Judgement{
			Was: row.Drift, Now: identityVerdict(row, match, matched),
			RepairCount: row.RepairCount, RepairedAt: row.RepairedAt,
		}
		outcome, finding := v.one(ctx, p, row, match, matched, stopped, inbounds, at, &report)
		if finding != nil {
			report.Findings = append(report.Findings, *finding)
			switch finding.Action {
			case ActionRecreated, ActionRestored:
				judgement.Repaired = true
			case ActionContested:
				judgement.Held = true
			}
		}
		report.Drift[row.ConfigID] = judgement
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
// what it should carry. Every write goes to the client the match found.
func (v *Provisioning) one(
	ctx context.Context, p collect.Panel, row DesiredConfig, match Match, matched, stopped bool,
	inbounds *inboundCache, at time.Time, report *ProvisionReport,
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
	client := match.Client

	if !row.Present {
		if !matched {
			// Gone, by our delete or anyone's, under every key. The read is
			// the confirmation, and it is the only thing that clears the id.
			report.Synced++
			return outcome("", StateComplete), nil
		}
		if err := p.Driver.DeleteClient(ctx, client.RemoteID); err != nil {
			return refused(client.RemoteID, err)
		}
		report.Written++
		report.Removed[client.RemoteID] = true
		return outcome(client.RemoteID, StatePartial), found(ActionDeleted, client.RemoteID, nil)
	}

	if !matched {
		if row.RemoteID != "" {
			// Ours, and on the panel under no key: `missing`. Recreating it is
			// a repair, so it waits on the stop. The user has paid for a seat
			// and the tag and credential are ours, so it is otherwise created
			// exactly as the first time (F-027-ab).
			if stopped {
				report.Skipped++
				return nil, found(ActionContested, row.RemoteID, nil)
			}
			o, f := v.create(ctx, p, row, inbounds, report, outcome, found, refused)
			if f != nil && f.Action == ActionCreated {
				f.Action = ActionRecreated
			}
			return o, f
		}
		return v.create(ctx, p, row, inbounds, report, outcome, found, refused)
	}

	if row.RemoteID == "" {
		// A create whose answer never reached us. Adopting it is the
		// difference between one seat and two.
		report.Written++
		return outcome(client.RemoteID, StatePartial), found(ActionAdopted, client.RemoteID, nil)
	}

	rebuilt := match.By == ByUUID && row.ClaimTag != "" && client.Label != row.ClaimTag
	if rebuilt && stopped {
		// The tag is the repair and it is held. The ceiling is not held when
		// the client allows more than ours, and a client made again by hand
		// usually has none: that is the exception, written and not counted.
		// The row still follows its client, because a re-key writes nothing.
		if row.AllocatedBytes != nil {
			want := PanelCeiling(*row.AllocatedBytes, row.ServedBytes)
			if have := client.DataLimitBytes; have == 0 || have > want {
				if err := p.Driver.SetClientDataLimit(ctx, client.RemoteID, want); err != nil {
					return refused(client.RemoteID, err)
				}
				report.Written++
			}
		}
		return outcome(client.RemoteID, StatePartial), found(ActionContested, client.RemoteID, nil)
	}
	switch {
	case client.UUID != row.UUID || rebuilt:
		// A regenerate, or a client made again without our tag. The update
		// carries the whole client as it should now be. The ceiling is the one
		// the panel holds, because sizing it is the ceiling pass's and it runs
		// next — except on a rebuilt client, which holds none: that one gets
		// the first block a create would, in its new counter's origin.
		limit := client.DataLimitBytes
		if rebuilt && row.AllocatedBytes != nil {
			limit = PanelCeiling(*row.AllocatedBytes, row.ServedBytes)
		}
		err := p.Driver.UpdateClient(ctx, driver.UpdateClientRequest{
			RemoteID: client.RemoteID, ClaimTag: row.ClaimTag, UUID: row.UUID,
			InboundRemoteID: client.InboundRemoteID, DataLimitBytes: limit,
			RateLimitBps: client.RateLimitBps, ExpiresAt: client.ExpiresAt, Enabled: row.Enabled,
		})
		if err != nil {
			return refused(client.RemoteID, err)
		}
		report.Written++
		action := ActionCredentialRotated
		if client.UUID == row.UUID {
			action = ActionRestored
		}
		return outcome(client.RemoteID, StatePartial), found(action, client.RemoteID, nil)
	case client.Enabled != row.Enabled:
		if err := p.Driver.SetClientEnabled(ctx, client.RemoteID, row.Enabled); err != nil {
			return refused(client.RemoteID, err)
		}
		report.Written++
		action := ActionDisabled
		if row.Enabled {
			action = ActionEnabled
		}
		return outcome(client.RemoteID, StatePartial), found(action, client.RemoteID, nil)
	case client.RemoteID != row.RemoteID:
		report.Synced++
		return outcome(client.RemoteID, StateComplete), found(ActionRekeyed, client.RemoteID, nil)
	default:
		report.Synced++
		return outcome(client.RemoteID, StateComplete), nil
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
	if prov.Written > 0 || prov.Failed > 0 || ceil.Written > 0 || ceil.Failed > 0 || len(prov.Orphans) > 0 {
		c.log().Info("panel converged",
			"panel", p.ID, "provisioned", prov.Written, "provision_failed", prov.Failed,
			"ceilings_written", ceil.Written, "ceilings_failed", ceil.Failed, "orphans", len(prov.Orphans))
	}
	return nil
}

// Pass returns an error only where the panel could not be read or the rows
// could not be recorded.
func (c *Converger) Pass(ctx context.Context, p collect.Panel, res collect.Result) (report ConvergeReport, err error) {
	clients, err := p.Driver.ListClients(ctx)
	if err != nil {
		return report, err
	}
	if c.Provisioning != nil {
		report.Provisioning, err = c.Provisioning.PassOver(ctx, p, clients, res.ObservedAt)
		if err != nil {
			return report, err
		}
		defer func() {
			if err == nil {
				err = c.recordDrift(ctx, report, res.ObservedAt)
			}
		}()
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
		report.Ceilings, err = c.Ceilings.PassOver(ctx, p, res, remaining, report.Provisioning.Stopped)
	}
	return report, err
}

// recordDrift completes provisioning's identity verdicts with the ceiling
// pass's and writes the ones that changed, and every repair (F-027-aa,
// F-027-ab).
func (c *Converger) recordDrift(ctx context.Context, report ConvergeReport, at time.Time) error {
	judge(report.Provisioning.Drift, report.Ceilings)
	rows := changed(report.Provisioning.Drift, at)
	if len(rows) == 0 {
		return nil
	}
	return c.Provisioning.Desired.RecordDrift(ctx, rows)
}

func (c *Converger) log() *slog.Logger {
	if c.Log != nil {
		return c.Log
	}
	return slog.Default()
}
