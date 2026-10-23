package converge

import (
	"context"
	"errors"

	"network-service/internal/collect"
	"network-service/internal/driver"
)

// An adopted login (F-1601-b2, ADR-0160 decisions 6-8): a config an import made
// in place for a User Manager user that keeps its own login on the router. Its
// `uuid` is ours and never the router's credential, so the pass never compares
// or writes it, and never makes the user again — a new login is exactly what
// an import in place exists to avoid. Our claim tag in the user's label is
// the mark that the adoption is done (driver.Adopter).

// Adoption is the row's in-place half: empty AdoptedProfile is a config of ours.
type Adoption struct {
	// AdoptedProfile is `adoptedProfile`, the user's own profile at import,
	// and AdoptedLabel `adoptedLabel`, its own label: what a hand back restores.
	AdoptedProfile string
	AdoptedLabel   string
	// HandBack is `handBack`: an absent row hands the user back (an import's
	// rollback) instead of deleting it (a normal end).
	HandBack bool
}

func (a Adoption) adopted() bool { return a.AdoptedProfile != "" }

const (
	// ActionAdoptedInPlace: the user was put under its first ceiling, its own
	// profile off and its credential untouched.
	ActionAdoptedInPlace Action = "adopted_in_place"
	// ActionHandedBack: the user got its own profile and label back.
	ActionHandedBack Action = "handed_back"
	// ActionLoginGone: the router no longer holds the login under any key.
	// Nothing is made in its place: the credential is the customer's, not ours.
	ActionLoginGone Action = "login_gone"
)

// inPlace is the pass for the states only an adopted row has. done is false
// for the rest — present, adopted, found — which the ordinary pass carries,
// less the credential (one()).
func (v *Provisioning) inPlace(
	ctx context.Context, p collect.Panel, row DesiredConfig, client driver.RemoteClient, matched bool, report *ProvisionReport,
	outcome func(string, EnforcementState) *Outcome,
	found func(Action, string, error) *ProvisionFinding,
) (o *Outcome, f *ProvisionFinding, done bool) {
	refused := func(remoteID string, err error) (*Outcome, *ProvisionFinding, bool) {
		report.Failed++
		return nil, found(ActionRefused, remoteID, err), true
	}
	ours := matched && client.Label == row.ClaimTag
	switch {
	case !row.adopted() || (!row.Present && !row.HandBack) || (!row.Present && !matched):
		return nil, nil, false
	case !row.Present && row.State == StatePartial && !ours:
		// The read after our hand back: the user is the reseller's again.
		report.Synced++
		return outcome("", StateComplete), nil, true
	case !row.Present:
		// Repeated until a read confirms it: it is safe on a user half adopted.
		adopter, ok := driver.AdopterOf(p.Driver)
		if !ok {
			return refused(client.RemoteID, errNoAdopter)
		}
		err := adopter.ReleaseClient(ctx, driver.ReleaseRequest{RemoteID: client.RemoteID, Profile: row.AdoptedProfile, Label: row.AdoptedLabel})
		if err != nil {
			return refused(client.RemoteID, err)
		}
		report.Written++
		return outcome(client.RemoteID, StatePartial), found(ActionHandedBack, client.RemoteID, nil), true
	case !matched:
		report.Skipped++
		return nil, found(ActionLoginGone, row.RemoteID, nil), true
	case ours:
		return nil, nil, false
	}
	ceiling, skip := firstBlock(row)
	if skip != "" {
		report.Skipped++
		return nil, found(skip, client.RemoteID, nil), true
	}
	adopter, ok := driver.AdopterOf(p.Driver)
	if !ok {
		return refused(client.RemoteID, errNoAdopter)
	}
	err := adopter.AdoptClient(ctx, driver.AdoptRequest{
		RemoteID: client.RemoteID, ClaimTag: row.ClaimTag, DataLimitBytes: ceiling, NoDataLimit: row.Unlimited,
		RateLimitBps: rateFor(p, row, client), Enabled: row.Enabled,
	})
	if err != nil {
		return refused(client.RemoteID, err)
	}
	report.Written++
	// The router's counter starts at the link, as at a create (F-027-du).
	o = outcome(client.RemoteID, StatePartial)
	baseline := row.SessionBytes
	o.SessionBaseline = &baseline
	return o, found(ActionAdoptedInPlace, client.RemoteID, nil), true
}

var errNoAdopter = driver.NewFault(driver.FaultUnsupported, "inPlace", 0, errors.New("this panel's family adopts no login in place"))

// firstBlock is the ceiling a new counter starts under — a created client's,
// or an adopted one's — or why there is none to write yet. An unlimited
// config is written with no limit (F-111-r); otherwise everything the config
// has already carried is the offset.
func firstBlock(row DesiredConfig) (int64, Action) {
	switch {
	case row.Unlimited:
		return 0, ""
	case row.AllocatedBytes == nil:
		return 0, ActionAwaitingAllocation
	}
	if ceiling := firstCeiling(row); ceiling > 0 {
		return ceiling, ""
	}
	return 0, ActionAllowanceExhausted
}
