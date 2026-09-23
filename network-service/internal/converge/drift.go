package converge

import (
	"time"

	"network-service/internal/driver"
)

// The drift comparison (F-027-aa): which remote client is which config, and
// what the panel did to it that we did not.
//
// A config is matched to a client by three keys, tried in order over the one
// population the pass read:
//
//  1. `remoteId` — the panel's own id, which is what a rename changes;
//  2. `claimTag` — ours and global (invariant 17), written into the client's
//     label on every family that has one, which is what survives a rename;
//  3. `uuid` — the credential the user carries, which survives even a client
//     deleted and made again by hand.
//
// Each key only reaches the clients the keys before it left unclaimed, so no
// client is ever two configs'. Without the second key a rename is a vanished
// client: its usage goes unattributed and the user, whose config still works,
// is cut off by the next purge of a config we think is gone.
//
// A verdict is what the last read found, never a history: a re-keyed identity
// reads `synced` on the next pass, and the finding and the log line are the
// record that it happened. What to do about a verdict past the identity repair
// — the anti-flap stop, recreating a missing client, the panel-wide event — is
// F-027-ab's.

// DriftState is `network.DriftState`.
type DriftState string

const (
	// DriftSynced: the client is where the row says, holding what it says.
	DriftSynced DriftState = "synced"
	// DriftReset: this pass saw the client's counter go backward. The ceiling
	// pass has already rewritten the ceiling for it.
	DriftReset DriftState = "reset"
	// DriftRenamed: our tag was found on a client under another id. The same
	// client, a new name; the row is re-keyed to it and its counter follows
	// from the next read.
	DriftRenamed DriftState = "renamed"
	// DriftRebuilt: our uuid was found on a client under another id without
	// our tag — made again from the credential, or renamed on a family that
	// keeps no label. The row is re-keyed and the tag and ceiling written
	// back, because the rebuilt client carries neither.
	DriftRebuilt DriftState = "rebuilt"
	// DriftMissing: a client we created is on the panel under none of the
	// three keys. It is not recreated here: a recreate is a repair, and
	// repairs are behind the anti-flap stop (F-027-ab).
	DriftMissing DriftState = "missing"
	// DriftOrphan names the panel's clients no config claims. It is a verdict
	// on a client, not a config — no row carries it — and the client is left
	// alone: the panel's `orphanPolicy` defaults to `report_only`.
	DriftOrphan DriftState = "orphan"
	// DriftLimitOverridden: the panel enforces a ceiling that is neither ours
	// nor the one it last confirmed — somebody else wrote it. The ceiling pass
	// has already rewritten it.
	DriftLimitOverridden DriftState = "limit_overridden"
)

// MatchKey names which of the three keys found a client.
type MatchKey string

const (
	ByRemoteID MatchKey = "remote_id"
	ByClaimTag MatchKey = "claim_tag"
	ByUUID     MatchKey = "uuid"
)

// Match is the client a config was found as, and how.
type Match struct {
	Client driver.RemoteClient
	By     MatchKey
}

// Matching is one panel's population sorted into ours and not ours.
type Matching struct {
	ByConfig map[string]Match
	// Orphans are the clients no config claims by any key, in panel order.
	Orphans []driver.RemoteClient
}

// MatchClients matches every row — present and absent alike, because a
// deleted config's client renamed away from us still holds a seat — against
// the clients the panel reported.
func MatchClients(rows []DesiredConfig, clients []driver.RemoteClient) Matching {
	m := Matching{ByConfig: make(map[string]Match, len(rows))}
	claimed := make(map[string]bool, len(clients))

	byRemote := make(map[string]driver.RemoteClient, len(clients))
	byTag := make(map[string]driver.RemoteClient, len(clients))
	byUUID := make(map[string]driver.RemoteClient, len(clients))
	for _, c := range clients {
		byRemote[c.RemoteID] = c
		if c.Label != "" {
			byTag[c.Label] = c
		}
		if c.UUID != "" {
			byUUID[c.UUID] = c
		}
	}

	keys := []struct {
		by  MatchKey
		key func(DesiredConfig) string
		in  map[string]driver.RemoteClient
	}{
		{ByRemoteID, func(r DesiredConfig) string { return r.RemoteID }, byRemote},
		{ByClaimTag, func(r DesiredConfig) string { return r.ClaimTag }, byTag},
		{ByUUID, func(r DesiredConfig) string { return r.UUID }, byUUID},
	}
	for _, k := range keys {
		for _, row := range rows {
			if _, done := m.ByConfig[row.ConfigID]; done {
				continue
			}
			value := k.key(row)
			if value == "" {
				continue
			}
			if c, ok := k.in[value]; ok && !claimed[c.RemoteID] {
				m.ByConfig[row.ConfigID] = Match{Client: c, By: k.by}
				claimed[c.RemoteID] = true
			}
		}
	}

	for _, c := range clients {
		if !claimed[c.RemoteID] {
			m.Orphans = append(m.Orphans, c)
		}
	}
	return m
}

// identityVerdict is what the match alone says about one row. A row with no
// `remoteId` has not been created yet, or its create's answer was lost: a
// client found for it by tag or uuid is ours being adopted, not drift.
func identityVerdict(row DesiredConfig, m Match, matched bool) DriftState {
	switch {
	case row.RemoteID == "":
		return DriftSynced
	case !matched && row.Present:
		return DriftMissing
	case matched && m.By == ByClaimTag:
		return DriftRenamed
	case matched && m.By == ByUUID:
		return DriftRebuilt
	default:
		return DriftSynced
	}
}

// Judgement is one config's verdict this pass, beside the one its row holds.
type Judgement struct {
	Was DriftState
	Now DriftState
}

// Verdict is one `driftState` to write.
type Verdict struct {
	ConfigID string
	Drift    DriftState
	At       time.Time
}

// judge folds the ceiling pass's findings into provisioning's identity
// verdicts. An identity verdict outranks both: a client that was just
// re-keyed has a ceiling written for the first time under its new name, and
// that is not somebody else's number.
func judge(judgements map[string]Judgement, ceilings Report) {
	for _, f := range ceilings.Findings {
		j, ok := judgements[f.ConfigID]
		if !ok || j.Now != DriftSynced {
			continue
		}
		switch {
		case f.Reason == ReasonCounterReset:
			j.Now = DriftReset
		case f.Overridden:
			j.Now = DriftLimitOverridden
		default:
			continue
		}
		judgements[f.ConfigID] = j
	}
}

// changed is the verdicts that differ from what the rows hold. A row that has
// never been judged holds nothing, which reads as synced.
func changed(judgements map[string]Judgement, at time.Time) []Verdict {
	var out []Verdict
	for configID, j := range judgements {
		was := j.Was
		if was == "" {
			was = DriftSynced
		}
		if j.Now != was {
			out = append(out, Verdict{ConfigID: configID, Drift: j.Now, At: at})
		}
	}
	return out
}
