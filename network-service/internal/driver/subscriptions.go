package driver

import (
	"context"
	"errors"
)

// SubscriptionsReader is what an import source adds (F-203-a): every client's
// own subscription URL, by RemoteID, from the family's bulk reads. It is the
// address the reseller's users already hold, which keeps answering after the
// move. SubscriptionURL is one client a request, and a 20 000-client source
// cannot be read that way (contract.source.md rule 4). A client the panel
// gives no address (its sub server off, no subId) is absent.
//
// It is optional, so ask through SubscriptionsOf: a paced driver hides its family's.
type SubscriptionsReader interface {
	SubscriptionURLs(ctx context.Context) (map[string]string, error)
}

// SubscriptionsOf is the reader's SubscriptionsReader, if its family has one,
// looked up through the pacing wrapper, which paces it like any other request.
func SubscriptionsOf(r any) (SubscriptionsReader, bool) {
	if p, ok := r.(*paced); ok {
		if _, has := p.Driver.(SubscriptionsReader); !has {
			return nil, false
		}
		return p, true
	}
	s, ok := r.(SubscriptionsReader)
	return s, ok
}

// SubscriptionURLs is the family's SubscriptionsReader, paced (SubscriptionsOf
// says whether it has one).
func (p *paced) SubscriptionURLs(ctx context.Context) (map[string]string, error) {
	return share(ctx, p, "SubscriptionURLs", "SubscriptionURLs", func(ctx context.Context) (map[string]string, error) {
		s, ok := p.Driver.(SubscriptionsReader)
		if !ok {
			return nil, NewFault(FaultUnsupported, "SubscriptionURLs", 0, errors.New("this family lists no subscription urls"))
		}
		return s.SubscriptionURLs(ctx)
	})
}
