package converge

import (
	"context"
	"slices"
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
// A family that builds lines from the pass's own read hands them over in
// ListClients (driver.RemoteClient.LinesRead): those are compared on every
// pass and written only on a change, with no request and no cap, so an edit
// on the panel reaches `/sub` in the next pass (rule 6b).
//
// Otherwise, lines read from this very client are still read again — a refresh, rule 6b
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
	// CheckedAt is the last read of them, a refresh's too; At moves only when
	// the lines or the uuid changed, since it is when these lines began to be
	// served (rule 7, billing's drain waits on it). Zero with At set: none since.
	CheckedAt time.Time
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
	case at.Sub(l.checked()) >= LinesRecapture:
		return refreshAged
	}
	return refreshNone
}

// checked is when these lines were last read: a row captured before
// CheckedAt existed has only At.
func (l CapturedLinks) checked() time.Time {
	if l.CheckedAt.IsZero() {
		return l.At
	}
	return l.CheckedAt
}

// same says whether lines read now for uuid are the ones already served, so
// that the time they are served since stands.
func (l CapturedLinks) same(lines []string, uuid string) bool {
	return !l.At.IsZero() && l.UUID == uuid && slices.Equal(l.Lines, lines)
}

// From says whether these lines were read from this client and still stand
// at `at`: lines always do, none only for EmptyRecapture.
func (l CapturedLinks) From(client driver.RemoteClient, at time.Time) bool {
	if l.At.IsZero() || l.RemoteID != client.RemoteID || l.UUID != client.UUID {
		return false
	}
	return len(l.Lines) > 0 || at.Sub(l.checked()) < EmptyRecapture
}

// ActionLinksUnread: the client is confirmed and its lines could not be read.
// Err is a *driver.Fault. The stored lines are kept, never erased, and the
// capture is retried on the next pass because its key still differs.
const ActionLinksUnread Action = "links_unread"

// capture reads one confirmed client's lines into its outcome when the row's
// were read from another client, or are due a refresh. A failed read is a finding and leaves the
// outcome without lines.
func (v *Provisioning) capture(ctx context.Context, p collect.Panel, row DesiredConfig, client driver.RemoteClient, outcome *Outcome, report *ProvisionReport) {
	if client.LinesRead {
		if row.Links.RemoteID != client.RemoteID || !row.Links.same(client.Lines, client.UUID) {
			report.Captured++
			outcome.Links = row.Links.read(client, client.Lines, outcome.At, row.InboundFingerprint)
		}
		return
	}
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
	outcome.Links = row.Links.read(client, lines, outcome.At, row.InboundFingerprint)
}

// read is lines just read from client at `at`, over the stored l: they are
// served since `at` unless they are the ones already served.
func (l CapturedLinks) read(client driver.RemoteClient, lines []string, at time.Time, fingerprint string) *CapturedLinks {
	since := at
	if l.same(lines, client.UUID) {
		since = l.At
	}
	return &CapturedLinks{
		Lines: lines, RemoteID: client.RemoteID, UUID: client.UUID, At: since, CheckedAt: at,
		InboundFingerprint: fingerprint,
	}
}
