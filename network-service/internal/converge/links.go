package converge

import (
	"context"
	"time"

	"network-service/internal/collect"
	"network-service/internal/driver"
)

// A config's link lines are captured by the provisioning pass and stored on
// its row; `/sub` renders them and never contacts a panel (ADR-0082 rule 2,
// F-027-bj, contract.links.md).
//
// A capture runs on the read that confirms a client — `complete`, never on
// our own write — and only when the stored lines were read from another
// client: another `remoteId` or another `uuid`. That one rule is every
// trigger the ADR names. A create, a move (a new row) and a recreate confirm a
// client the row has no lines from; a regenerate confirms a new `uuid`; a
// rename or a rebuild re-keys `remoteId`. A config nobody changed is never
// asked again, so capture spends no budget on a steady panel.

// CapturedLinks is `linkLines` and the key they were captured under. At is
// zero for a config never captured, which is not the same as one captured
// with no lines: the second is a family or panel that gives none.
type CapturedLinks struct {
	Lines    []string
	RemoteID string
	UUID     string
	At       time.Time
}

// From says whether these lines were read from this client.
func (l CapturedLinks) From(client driver.RemoteClient) bool {
	return !l.At.IsZero() && l.RemoteID == client.RemoteID && l.UUID == client.UUID
}

// ActionLinksUnread: the client is confirmed and its lines could not be read.
// Err is a *driver.Fault. The stored lines are kept, never erased, and the
// capture is retried on the next pass because its key still differs.
const ActionLinksUnread Action = "links_unread"

// capture reads one confirmed client's lines into its outcome when the row's
// were read from another client. A failed read is a finding and leaves the
// outcome without lines.
func (v *Provisioning) capture(ctx context.Context, p collect.Panel, row DesiredConfig, client driver.RemoteClient, outcome *Outcome, report *ProvisionReport) {
	if row.Links.From(client) {
		return
	}
	lines, err := p.Driver.ClientLinks(ctx, client)
	if err != nil {
		report.Findings = append(report.Findings, ProvisionFinding{
			ConfigID: row.ConfigID, RemoteID: client.RemoteID, Action: ActionLinksUnread, Err: err,
		})
		return
	}
	report.Captured++
	outcome.Links = &CapturedLinks{Lines: lines, RemoteID: client.RemoteID, UUID: client.UUID, At: outcome.At}
}
