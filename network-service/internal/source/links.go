package source

import (
	"context"
	"errors"
	"fmt"

	"network-service/internal/driver"
)

// MaxLinkBatch is the most clients one Links call reads. Most families answer
// a client's subscription URL and lines one request each, so a whole source
// would be tens of thousands of requests; the dry run asks in batches it can
// retry and report progress on (user, 2026-10-21).
const MaxLinkBatch = 200

// RequestsPerMinute is the pace a source is read at. It is the reseller's live
// panel, still serving its users: 300 a minute is a few requests a second, and
// the pacer halves it on a 429 or a 5xx (F-027-df). A batch of 200 clients is
// at most 400 requests — under a minute and a half.
const RequestsPerMinute = 300

// ErrBatchTooLarge is a Links call past MaxLinkBatch.
var ErrBatchTooLarge = errors.New("source: link batch past its cap")

// LinkRequest is one client to read links for, as Snapshot answered it:
// the driver finds a client by these, not by a read of the whole panel.
type LinkRequest struct {
	RemoteID        string `json:"remoteId"`
	UUID            string `json:"uuid"`
	Label           string `json:"label"`
	InboundRemoteID string `json:"inboundRemoteId"`
	// LinesRead: the snapshot already holds its lines, so only the
	// subscription URL is read.
	LinesRead bool `json:"linesRead"`
}

// ClientLinks is one client's subscription URL — what F-203 keeps answering —
// and its lines. Failure is a client the panel answered nothing usable for;
// the batch goes on without it.
type ClientLinks struct {
	RemoteID        string   `json:"remoteId"`
	SubscriptionURL string   `json:"subscriptionUrl,omitempty"`
	Lines           []string `json:"lines"`
	LinesRead       bool     `json:"linesRead"`
	Failure         string   `json:"failure,omitempty"`
}

// Links reads each client's subscription URL and, where the snapshot had
// none, its lines. A protocol fault is that client's and is recorded on it;
// any other fault — the panel down, refusing us, too slow — is the batch's,
// and the caller retries the batch.
func Links(ctx context.Context, r Reader, batch []LinkRequest) ([]ClientLinks, error) {
	if len(batch) > MaxLinkBatch {
		return nil, fmt.Errorf("%w: %d, the cap is %d", ErrBatchTooLarge, len(batch), MaxLinkBatch)
	}
	out := make([]ClientLinks, 0, len(batch))
	for _, req := range batch {
		got := ClientLinks{RemoteID: req.RemoteID}
		got.SubscriptionURL, _ = r.SubscriptionURL(ctx, req.RemoteID)
		if !req.LinesRead {
			lines, err := r.ClientLinks(ctx, driver.RemoteClient{
				RemoteID: req.RemoteID, UUID: req.UUID, Label: req.Label, InboundRemoteID: req.InboundRemoteID,
			})
			var fault *driver.Fault
			switch {
			case err == nil:
				got.Lines, got.LinesRead = lines, true
			case errors.As(err, &fault) && fault.Kind == driver.FaultProtocol:
				got.Failure = fault.Error()
			default:
				return nil, err
			}
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		out = append(out, got)
	}
	return out, nil
}
