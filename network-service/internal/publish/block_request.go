package publish

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"network-service/internal/leaseplan"
)

// BlockRequestRoutingKey is the key the lease planner asks billing for a
// metered block under (F-027-dc, `contracts/network/block-request.json`).
// Not under `network.usage.`: metering-service binds that prefix and
// dead-letters any key there that is not a pass or a release.
const BlockRequestRoutingKey = "network.lease.block_request"

// BlockRequestMessageVersion is the fixture's `version`.
const BlockRequestMessageVersion = 1

// BlockRequestMessage is the wire of one request. Bytes are decimal strings,
// as on the delta wire: billing stores them in a BIGINT.
type BlockRequestMessage struct {
	Version        int    `json:"version"`
	GrantID        string `json:"grantId"`
	PurchasedBytes string `json:"purchasedBytes"`
	TargetBytes    string `json:"targetBytes"`
	RateBps        string `json:"rateBps"`
	RequestedAt    string `json:"requestedAt"`
}

var blockRequestNamespace = mustUUID("0d6e3b52-9c1f-5a47-8e2d-4b7f1a3c5e90")

// BlockRequests is the planner's BlockRequester over the broker. The message
// id is derived from the Grant, the bag and the clock, so a republish of one
// request carries one id; billing's own guard is the bag it names.
type BlockRequests struct {
	Transport Transport
}

var _ leaseplan.BlockRequester = BlockRequests{}

func (b BlockRequests) RequestBlock(ctx context.Context, req leaseplan.BlockRequest) error {
	msg := BlockRequestMessage{
		Version:        BlockRequestMessageVersion,
		GrantID:        req.GrantID,
		PurchasedBytes: strconv.FormatInt(req.PurchasedBytes, 10),
		TargetBytes:    strconv.FormatInt(req.TargetBytes, 10),
		RateBps:        strconv.FormatInt(req.RateBps, 10),
		RequestedAt:    req.RequestedAt.UTC().Format(time.RFC3339Nano),
	}
	body, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("encode block request for grant %s: %w", req.GrantID, err)
	}
	id := uuidV5(blockRequestNamespace, msg.GrantID+deltaIDSeparator+msg.PurchasedBytes+deltaIDSeparator+msg.RequestedAt).String()
	if err := b.Transport.Publish(ctx, BlockRequestRoutingKey, id, body); err != nil {
		return fmt.Errorf("publish block request for grant %s: %w", req.GrantID, err)
	}
	return nil
}
