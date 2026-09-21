// Package publish is where a collection pass leaves this process (F-027-m).
//
// The routing key it publishes under and every field it writes are declared in
// `contracts/network/delta.json`, not here: network-service is not in the Nx
// workspace and cannot import `shared-core`, so the fixture plus a test on
// each side replaces the import that does not exist (ADR-0036, C-04/C-08).
// `delta_contract_test.go` is the Go half.
//
// Three decisions are worth reading before changing anything in here, because
// each of them is the kind that is only wrong in the accounts:
//
//   - **One message is one pass**, carrying all three streams. The pass is the
//     unit that has to be durable before a cursor moves (invariant 18), and a
//     pass carries what we believe, what we do not, and what we could not
//     place. Publishing only the deltas drops the other two silently.
//   - **A byte figure is a decimal string.** Both ends store it in a BIGINT;
//     a JSON number past 2^53 is already wrong when `JSON.parse` returns it.
//   - **`deltaId` is derived from the delta, never generated.** It is
//     `usage_delta_seen.deltaId`, the idempotency key of the whole metering
//     path (F-027-n), so a redelivered message has to carry the id its first
//     delivery carried.
package publish

import (
	"crypto/sha1" //nolint:gosec // UUIDv5 is defined over SHA-1 (RFC 4122 §4.3); not a security use.
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"

	"network-service/internal/collect"
)

// MessageVersion is `contracts/network/delta.json`'s `version`. A consumer
// refuses a version it was not written against rather than guessing at a
// field it does not know.
const MessageVersion = 1

// DefaultExchange is the exchange every automation message already rides
// (F-079), overridden by AUTOMATION_EXCHANGE. It is declared in
// `shared-core/src/lib/automation/bot-update.ts` as well; this side cannot
// import that file, which is what the fixture is for.
const DefaultExchange = "txnet.automation"

// UsageDeltaRoutingKey is the one key a pass is published under. The prefix is
// not decoration: a consumer binds `network.usage.#` off an exchange that
// already carries `automation.tick.#`, `otp.delivery.#` and `outbox.#`.
const UsageDeltaRoutingKey = "network.usage.delta"

// MaxDeltasPerMessage bounds one message. A panel with 5000 clients would
// otherwise be one multi-megabyte frame; the chunks are still one pass and one
// moment, and each delta carries its own id, so a chunk republished is
// absorbed rather than billed twice.
const MaxDeltasPerMessage = 500

// UsageDeltaMessage is one pass over one panel, as it goes on the wire. The
// field order is the fixture's, and the contract test holds it there.
type UsageDeltaMessage struct {
	Version       int            `json:"version"`
	PanelID       string         `json:"panelId"`
	OwnershipType string         `json:"ownershipType"`
	TenantID      *string        `json:"tenantId"`
	ObservedAt    string         `json:"observedAt"`
	Chunk         int            `json:"chunk"`
	Chunks        int            `json:"chunks"`
	Deltas        []Delta        `json:"deltas"`
	Quarantines   []Quarantine   `json:"quarantines"`
	Unattributed  []Unattributed `json:"unattributed"`
}

// Delta is one config's measured traffic for one interval.
type Delta struct {
	DeltaID    string `json:"deltaId"`
	ConfigID   string `json:"configId"`
	RemoteID   string `json:"remoteId"`
	Protocol   string `json:"protocol"`
	UpBytes    string `json:"upBytes"`
	DownBytes  string `json:"downBytes"`
	ObservedAt string `json:"observedAt"`
	SessionID  string `json:"sessionId"`
	AfterReset bool   `json:"afterReset"`
}

// Quarantine is a figure we measured and do not believe. `configId` is null
// where attribution is what failed.
type Quarantine struct {
	DeltaID    string  `json:"deltaId"`
	ConfigID   *string `json:"configId"`
	RemoteID   string  `json:"remoteId"`
	UpBytes    string  `json:"upBytes"`
	DownBytes  string  `json:"downBytes"`
	ObservedAt string  `json:"observedAt"`
	Reason     string  `json:"reason"`
}

// Unattributed is usage against a remote client no config claims.
type Unattributed struct {
	RemoteIdentifier string `json:"remoteIdentifier"`
	UpBytes          string `json:"upBytes"`
	DownBytes        string `json:"downBytes"`
	ObservedAt       string `json:"observedAt"`
}

// messages turns one pass into the messages that carry it: one, or one per
// chunk of MaxDeltasPerMessage deltas. The quarantined and unattributed rows
// ride the first chunk, once — they are a pass's other two streams, not a
// per-delta attachment, and a row on every chunk would be a row counted twice.
func messages(res collect.Result) []UsageDeltaMessage {
	if len(res.Deltas) == 0 && len(res.Quarantines) == 0 && len(res.Unattributed) == 0 {
		return nil
	}

	at := stamp(res.ObservedAt)
	chunks := (len(res.Deltas) + MaxDeltasPerMessage - 1) / MaxDeltasPerMessage
	if chunks == 0 {
		chunks = 1
	}

	out := make([]UsageDeltaMessage, 0, chunks)
	for i := 0; i < chunks; i++ {
		msg := UsageDeltaMessage{
			Version:       MessageVersion,
			PanelID:       res.PanelID,
			OwnershipType: res.OwnershipType,
			TenantID:      optional(res.TenantID),
			ObservedAt:    at,
			Chunk:         i + 1,
			Chunks:        chunks,
			Deltas:        []Delta{},
			Quarantines:   []Quarantine{},
			Unattributed:  []Unattributed{},
		}
		for _, d := range res.Deltas[i*MaxDeltasPerMessage : end(len(res.Deltas), i)] {
			msg.Deltas = append(msg.Deltas, wireDelta(res.PanelID, d))
		}
		if i == 0 {
			for _, q := range res.Quarantines {
				msg.Quarantines = append(msg.Quarantines, wireQuarantine(res.PanelID, q))
			}
			for _, u := range res.Unattributed {
				msg.Unattributed = append(msg.Unattributed, Unattributed{
					RemoteIdentifier: u.RemoteIdentifier,
					UpBytes:          bytesOf(u.UpBytes),
					DownBytes:        bytesOf(u.DownBytes),
					ObservedAt:       stamp(u.ObservedAt),
				})
			}
		}
		out = append(out, msg)
	}
	return out
}

func end(n, chunk int) int {
	if stop := (chunk + 1) * MaxDeltasPerMessage; stop < n {
		return stop
	}
	return n
}

func wireDelta(panelID string, d collect.Delta) Delta {
	return Delta{
		DeltaID:    DeltaID(panelID, d.RemoteID, d.SessionID, d.ObservedAt, d.UpBytes, d.DownBytes),
		ConfigID:   d.ConfigID,
		RemoteID:   d.RemoteID,
		Protocol:   d.Protocol,
		UpBytes:    bytesOf(d.UpBytes),
		DownBytes:  bytesOf(d.DownBytes),
		ObservedAt: stamp(d.ObservedAt),
		SessionID:  d.SessionID,
		AfterReset: d.AfterReset,
	}
}

func wireQuarantine(panelID string, q collect.Quarantine) Quarantine {
	return Quarantine{
		DeltaID:    DeltaID(panelID, q.RemoteID, "", q.ObservedAt, q.UpBytes, q.DownBytes),
		ConfigID:   optional(q.ConfigID),
		RemoteID:   q.RemoteID,
		UpBytes:    bytesOf(q.UpBytes),
		DownBytes:  bytesOf(q.DownBytes),
		ObservedAt: stamp(q.ObservedAt),
		Reason:     string(q.Reason),
	}
}

// bytesOf is the one place a byte figure becomes text. See the package comment.
func bytesOf(v int64) string { return strconv.FormatInt(v, 10) }

// stamp is RFC3339 with nanoseconds, in UTC. It is part of the delta id, so
// two spellings of one instant would be two ids for one delta.
func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// optional maps Go's empty string onto the JSON null a nullable column wants,
// so a consumer never has to decide whether "" meant absent.
func optional(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

// deltaIDNamespace and deltaIDSeparator are the fixture's; the id is a UUIDv5
// over them, so either side can recompute it from the message alone.
var deltaIDNamespace = mustUUID("6b5f2f7a-6a4f-5c1e-9a7b-2f3c4d5e6f70")

const deltaIDSeparator = "|"

// DeltaID is the idempotency key of one measured figure. It is a function of
// what was measured — never of the clock, the process or a counter — because a
// message the broker delivers twice must carry one id both times or
// `usage_delta_seen` cannot absorb the repeat (F-027-n).
func DeltaID(panelID, remoteID, sessionID string, observedAt time.Time, up, down int64) string {
	name := strings.Join([]string{
		panelID, remoteID, sessionID, stamp(observedAt), bytesOf(up), bytesOf(down),
	}, deltaIDSeparator)
	return uuidV5(deltaIDNamespace, name).String()
}

// uuid is a raw UUID. There is no uuid dependency in this module and this is
// the only place one is built, so the 16 bytes are handled here rather than
// pulled in.
type uuid [16]byte

func (u uuid) String() string {
	var b [36]byte
	hex.Encode(b[0:8], u[0:4])
	b[8] = '-'
	hex.Encode(b[9:13], u[4:6])
	b[13] = '-'
	hex.Encode(b[14:18], u[6:8])
	b[18] = '-'
	hex.Encode(b[19:23], u[8:10])
	b[23] = '-'
	hex.Encode(b[24:36], u[10:16])
	return string(b[:])
}

// uuidV5 is RFC 4122 §4.3: SHA-1 over the namespace and the name, with the
// version and variant bits set.
func uuidV5(namespace uuid, name string) uuid {
	h := sha1.New() //nolint:gosec // see the import comment.
	h.Write(namespace[:])
	h.Write([]byte(name))
	sum := h.Sum(nil)

	var out uuid
	copy(out[:], sum[:16])
	out[6] = (out[6] & 0x0f) | 0x50
	out[8] = (out[8] & 0x3f) | 0x80
	return out
}

func mustUUID(s string) uuid {
	raw, err := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	if err != nil || len(raw) != 16 {
		panic(fmt.Sprintf("not a uuid: %q", s))
	}
	var out uuid
	copy(out[:], raw)
	return out
}
