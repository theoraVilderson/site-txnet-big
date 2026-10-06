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
// A capture runs on the read that confirms a client — `complete` — and only
// when the stored lines were read from another client: another `remoteId` or
// another `uuid`. That one rule is every trigger the ADR names. A move (a new
// row) confirms a client the row has no lines from; a regenerate confirms a
// new `uuid`; a rename or a rebuild re-keys `remoteId`. A create and a
// recreate capture at once, from the client the panel answered with (F-111-k),
// and the confirming read then finds them read from that client. A config
// nobody changed is never asked again, so capture spends no budget on a
// steady panel — except one captured with no lines, asked again hourly.
//
// Lines read from this very client are still read again — a refresh, rule 6b
// — when what they were built from changed with no key of ours: the inbound
// was edited on the panel (its fingerprint, as the inventory read stores it,
// is not the one they were read under), or they are LinesRecapture old, for a
// family that cannot fingerprint its inbounds. A refresh spends the budget
// the pass's writes wait on (pace.go), so a pass makes few.

// CapturedLinks is `linkLines` and the key they were captured under. At is
// zero for a config never captured, which is not the same as one captured
// with no lines: the second is a family or panel that gives none.
type CapturedLinks struct {
	Lines    []string
	RemoteID string
	UUID     string
	At       time.Time
	// InboundFingerprint is the inbound's as the inventory read it when these
	// lines were read (rule 6b); empty is none known.
	InboundFingerprint string
}

// EmptyRecapture is how long a capture that stored no lines stands before it
// is asked again (ADR-0088 rule 5): once an hour per such config, inside the
// panel's budget, so lines that appear later fill in without a new key.
const EmptyRecapture = time.Hour

// LinesRecapture is how long captured lines stand before they are read again
// though nothing we see changed (rule 6b): a Marzban host or a Hiddify domain
// edited on the panel moves no fingerprint of ours.
const LinesRecapture = 24 * time.Hour

// InboundRefreshPerPass and AgedRefreshPerPass bound a pass's refreshes
// (rule 6b): a capture costs up to three requests of a default sixty a minute,
// and every write of the pass waits behind them. The cap counts both kinds,
// so an edited inbound's refreshes go before age's. A new key is never capped.
const (
	InboundRefreshPerPass = 10
	AgedRefreshPerPass    = 2
)

type refresh int

const (
	refreshNone refresh = iota
	refreshInbound
	refreshAged
)

// due says why lines read from this client are read again, if at all:
// fingerprint is the row's inbound's now, empty when none is known.
func (l CapturedLinks) due(fingerprint string, at time.Time) refresh {
	switch {
	case fingerprint != "" && l.InboundFingerprint != fingerprint:
		return refreshInbound
	case at.Sub(l.At) >= LinesRecapture:
		return refreshAged
	}
	return refreshNone
}

// From says whether these lines were read from this client and still stand
// at `at`: lines always do, none only for EmptyRecapture.
func (l CapturedLinks) From(client driver.RemoteClient, at time.Time) bool {
	if l.At.IsZero() || l.RemoteID != client.RemoteID || l.UUID != client.UUID {
		return false
	}
	return len(l.Lines) > 0 || at.Sub(l.At) < EmptyRecapture
}

// ActionLinksUnread: the client is confirmed and its lines could not be read.
// Err is a *driver.Fault. The stored lines are kept, never erased, and the
// capture is retried on the next pass because its key still differs.
const ActionLinksUnread Action = "links_unread"

// capture reads one confirmed client's lines into its outcome when the row's
// were read from another client, or are due a refresh. A failed read is a finding and leaves the
// outcome without lines.
func (v *Provisioning) capture(ctx context.Context, p collect.Panel, row DesiredConfig, client driver.RemoteClient, outcome *Outcome, report *ProvisionReport) {
	if row.Links.From(client, outcome.At) {
		switch row.Links.due(row.InboundFingerprint, outcome.At) {
		case refreshNone:
			return
		case refreshInbound:
			if report.Refreshed >= InboundRefreshPerPass {
				return
			}
		case refreshAged:
			if report.Refreshed >= AgedRefreshPerPass {
				return
			}
		}
		report.Refreshed++
	}
	lines, err := p.Driver.ClientLinks(ctx, client)
	if err != nil {
		report.Findings = append(report.Findings, ProvisionFinding{
			ConfigID: row.ConfigID, RemoteID: client.RemoteID, Action: ActionLinksUnread, Err: err,
		})
		return
	}
	report.Captured++
	outcome.Links = &CapturedLinks{
		Lines: lines, RemoteID: client.RemoteID, UUID: client.UUID, At: outcome.At, InboundFingerprint: row.InboundFingerprint,
	}
}
