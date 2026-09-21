package publish

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"testing"
	"time"

	"network-service/internal/collect"
)

// The invariants this row turns on, as behaviour rather than as a document:
//
//   - A pass is one message, and it carries all three streams. Publishing only
//     the deltas would drop quarantined and unattributed bytes on the floor,
//     which is invariant 18 broken at the one place it cannot be noticed.
//   - A byte figure is a decimal string. It is a BIGINT at both ends and a
//     JSON number past 2^53 arrives at the consumer already wrong.
//   - `deltaId` is a function of the delta, not of the clock. A redelivered
//     message must carry the id its first delivery carried or
//     `usage_delta_seen` cannot absorb it (F-027-n).
//   - A failed publish returns an error, so the caller leaves the cursor alone
//     and the same bytes are read again.

type recordingTransport struct {
	sent []sentMessage
	err  error
}

type sentMessage struct {
	routingKey string
	messageID  string
	body       []byte
}

func (r *recordingTransport) Publish(_ context.Context, routingKey, messageID string, body []byte) error {
	if r.err != nil {
		return r.err
	}
	r.sent = append(r.sent, sentMessage{routingKey: routingKey, messageID: messageID, body: body})
	return nil
}

func (r *recordingTransport) decoded(t *testing.T, i int) UsageDeltaMessage {
	t.Helper()
	var msg UsageDeltaMessage
	if err := json.Unmarshal(r.sent[i].body, &msg); err != nil {
		t.Fatalf("message %d is not the declared shape: %v", i, err)
	}
	return msg
}

func at(sec int) time.Time {
	return time.Date(2026, 9, 21, 10, 0, sec, 0, time.UTC)
}

func passResult() collect.Result {
	return collect.Result{
		PanelID:       "11111111-1111-1111-1111-111111111111",
		OwnershipType: "tenant",
		TenantID:      "22222222-2222-2222-2222-222222222222",
		ObservedAt:    at(0),
		Deltas: []collect.Delta{{
			PanelID:  "11111111-1111-1111-1111-111111111111",
			ConfigID: "33333333-3333-3333-3333-333333333333",
			RemoteID: "c1", Protocol: "vless",
			// Past 2^53: the figure the JSON-number shape gets wrong.
			UpBytes: 9007199254740993, DownBytes: 4096,
			ObservedAt: at(0), AfterReset: true,
		}},
		Quarantines: []collect.Quarantine{{
			PanelID:  "11111111-1111-1111-1111-111111111111",
			ConfigID: "44444444-4444-4444-4444-444444444444",
			RemoteID: "c2", UpBytes: 1, DownBytes: 2,
			ObservedAt: at(0), Reason: collect.ReasonImplausibleVolume,
		}},
		Unattributed: []collect.Unattributed{{
			PanelID:          "11111111-1111-1111-1111-111111111111",
			RemoteIdentifier: "stranger", UpBytes: 7, DownBytes: 8, ObservedAt: at(0),
		}},
	}
}

func TestOnePassIsOneMessageCarryingAllThreeStreams(t *testing.T) {
	tr := &recordingTransport{}
	p := Publisher{Transport: tr}

	if err := p.Publish(context.Background(), passResult()); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if len(tr.sent) != 1 {
		t.Fatalf("sent %d messages, want 1", len(tr.sent))
	}
	if tr.sent[0].routingKey != UsageDeltaRoutingKey {
		t.Errorf("routing key %q, want %q", tr.sent[0].routingKey, UsageDeltaRoutingKey)
	}

	msg := tr.decoded(t, 0)
	if msg.Version != MessageVersion || msg.Chunk != 1 || msg.Chunks != 1 {
		t.Errorf("envelope = v%d chunk %d/%d, want v%d 1/1", msg.Version, msg.Chunk, msg.Chunks, MessageVersion)
	}
	if msg.OwnershipType != "tenant" || msg.TenantID == nil || *msg.TenantID != "22222222-2222-2222-2222-222222222222" {
		t.Errorf("ownership = %q tenant = %v, want the panel's own (invariant 9)", msg.OwnershipType, msg.TenantID)
	}
	if len(msg.Deltas) != 1 || len(msg.Quarantines) != 1 || len(msg.Unattributed) != 1 {
		t.Fatalf("streams = %d/%d/%d, want one of each — a pass carries all three (invariant 18)",
			len(msg.Deltas), len(msg.Quarantines), len(msg.Unattributed))
	}
	if msg.Deltas[0].Protocol != "vless" {
		t.Errorf("protocol = %q, want the config's own (F-1002)", msg.Deltas[0].Protocol)
	}
	if !msg.Deltas[0].AfterReset {
		t.Error("afterReset was dropped; it is a fact about the delta, not a footnote")
	}
	if msg.Quarantines[0].ConfigID == nil || *msg.Quarantines[0].ConfigID != "44444444-4444-4444-4444-444444444444" {
		t.Errorf("quarantine configId = %v, want the attributed one", msg.Quarantines[0].ConfigID)
	}
	if msg.Unattributed[0].RemoteIdentifier != "stranger" {
		t.Errorf("unattributed remoteIdentifier = %q", msg.Unattributed[0].RemoteIdentifier)
	}
}

// The reason `bytes` is a string in the fixture. Asserted on the JSON itself,
// because a Go int64 survives a round trip through this process either way —
// the reader that does not is the consumer's JSON.parse.
func TestByteFiguresRideAsDecimalStrings(t *testing.T) {
	tr := &recordingTransport{}
	if err := (Publisher{Transport: tr}).Publish(context.Background(), passResult()); err != nil {
		t.Fatalf("publish: %v", err)
	}

	var raw struct {
		Deltas []struct {
			UpBytes json.RawMessage `json:"upBytes"`
		} `json:"deltas"`
	}
	if err := json.Unmarshal(tr.sent[0].body, &raw); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if string(raw.Deltas[0].UpBytes) != `"9007199254740993"` {
		t.Errorf("upBytes on the wire = %s, want a quoted decimal string", raw.Deltas[0].UpBytes)
	}
}

func TestDeltaIDIsAFunctionOfTheDeltaAndNotOfTheClock(t *testing.T) {
	first, second := &recordingTransport{}, &recordingTransport{}
	if err := (Publisher{Transport: first}).Publish(context.Background(), passResult()); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if err := (Publisher{Transport: second}).Publish(context.Background(), passResult()); err != nil {
		t.Fatalf("publish: %v", err)
	}
	a, b := first.decoded(t, 0), second.decoded(t, 0)
	if a.Deltas[0].DeltaID != b.Deltas[0].DeltaID {
		t.Fatalf("the same delta got two ids (%s, %s) — a redelivery would be billed twice",
			a.Deltas[0].DeltaID, b.Deltas[0].DeltaID)
	}

	moved := passResult()
	moved.Deltas[0].UpBytes++
	third := &recordingTransport{}
	if err := (Publisher{Transport: third}).Publish(context.Background(), moved); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if third.decoded(t, 0).Deltas[0].DeltaID == a.Deltas[0].DeltaID {
		t.Error("a different figure got the same id — the second one would be deduped away unbilled")
	}
}

func TestAWidePassIsChunkedAndEveryRowRidesExactlyOnce(t *testing.T) {
	res := collect.Result{
		PanelID: "11111111-1111-1111-1111-111111111111", OwnershipType: "platform",
		ObservedAt:   at(0),
		Unattributed: []collect.Unattributed{{PanelID: "11111111-1111-1111-1111-111111111111", RemoteIdentifier: "stranger", ObservedAt: at(0)}},
	}
	for i := 0; i < MaxDeltasPerMessage+1; i++ {
		res.Deltas = append(res.Deltas, collect.Delta{
			PanelID: res.PanelID, ConfigID: "33333333-3333-3333-3333-333333333333",
			RemoteID: "c" + strconv.Itoa(i), Protocol: "vmess",
			UpBytes: int64(i + 1), DownBytes: 0, ObservedAt: at(0),
		})
	}

	tr := &recordingTransport{}
	if err := (Publisher{Transport: tr}).Publish(context.Background(), res); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if len(tr.sent) != 2 {
		t.Fatalf("sent %d messages, want 2", len(tr.sent))
	}

	ids := map[string]int{}
	unattributed := 0
	for i := range tr.sent {
		msg := tr.decoded(t, i)
		if msg.Chunk != i+1 || msg.Chunks != 2 {
			t.Errorf("message %d is chunk %d/%d, want %d/2", i, msg.Chunk, msg.Chunks, i+1)
		}
		if msg.TenantID != nil {
			t.Errorf("a platform panel carried a tenantId (%v) — invariant 9", msg.TenantID)
		}
		for _, d := range msg.Deltas {
			ids[d.DeltaID]++
		}
		unattributed += len(msg.Unattributed)
	}
	if len(ids) != MaxDeltasPerMessage+1 {
		t.Errorf("%d distinct delta ids over the chunks, want %d", len(ids), MaxDeltasPerMessage+1)
	}
	for id, n := range ids {
		if n != 1 {
			t.Errorf("delta %s rode %d times", id, n)
		}
	}
	if unattributed != 1 {
		t.Errorf("unattributed rows rode %d times, want exactly 1", unattributed)
	}
}

func TestAnEmptyPassPublishesNothing(t *testing.T) {
	tr := &recordingTransport{}
	res := collect.Result{PanelID: "11111111-1111-1111-1111-111111111111", OwnershipType: "platform", ObservedAt: at(0)}
	// The cursor still moves: the advances are the caller's, and a pass that
	// measured nothing has nothing to tell anyone.
	if err := (Publisher{Transport: tr}).Publish(context.Background(), res); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if len(tr.sent) != 0 {
		t.Errorf("sent %d messages for a pass with nothing in it", len(tr.sent))
	}
}

func TestAFailedPublishIsAnError(t *testing.T) {
	boom := errors.New("broker unreachable")
	err := (Publisher{Transport: &recordingTransport{err: boom}}).Publish(context.Background(), passResult())
	if !errors.Is(err, boom) {
		t.Fatalf("publish error = %v, want the transport's — the cursor must not move (invariant 18)", err)
	}
}

// The publisher is the loop's sink, not a second thing shaped like one.
func TestPublisherIsACollectSink(t *testing.T) {
	var _ collect.Sink = Publisher{Transport: &recordingTransport{}}
}
