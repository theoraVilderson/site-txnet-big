package publish

import (
	"context"
	"encoding/json"
	"fmt"

	"network-service/internal/collect"
)

// Transport is the wire under the publisher: one message, published and
// confirmed, or an error. It is an interface so the message shape — the half
// of this row a consumer depends on — is proved without a broker, and so the
// AMQP half stays the small, untestable part it actually is.
//
// `messageID` rides as the AMQP `message_id` property, as `outbox.ts` already
// does with an event id: a consumer can then dedupe a redelivery before it
// parses anything.
type Transport interface {
	Publish(ctx context.Context, routingKey, messageID string, body []byte) error
}

// Publisher is the collection loop's Sink (F-027-m). It turns one pass into
// the declared message and hands it to the transport; it decides nothing about
// the bytes, which is the normaliser's job (F-027-l).
type Publisher struct {
	Transport Transport
}

// Publish sends one pass. It returns an error if any chunk did not reach the
// broker, and the caller must then leave the cursor where it is: the same
// bytes are read again next pass, and the repeat is what `usage_delta_seen`
// absorbs (invariant 18, F-027-n). A pass that measured nothing sends nothing.
func (p Publisher) Publish(ctx context.Context, res collect.Result) error {
	for _, msg := range messages(res) {
		body, err := json.Marshal(msg)
		if err != nil {
			return fmt.Errorf("encode pass for panel %s: %w", res.PanelID, err)
		}
		if err := p.Transport.Publish(ctx, UsageDeltaRoutingKey, messageID(msg), body); err != nil {
			return fmt.Errorf("publish pass for panel %s (chunk %d/%d): %w",
				res.PanelID, msg.Chunk, msg.Chunks, err)
		}
	}
	return nil
}

// messageID identifies one chunk of one pass the same way a delta id
// identifies one figure: derived, so a republish of the same chunk carries the
// id the first attempt carried.
func messageID(msg UsageDeltaMessage) string {
	return uuidV5(deltaIDNamespace, fmt.Sprintf("%s%s%s%s%d", msg.PanelID, deltaIDSeparator,
		msg.ObservedAt, deltaIDSeparator, msg.Chunk)).String()
}
