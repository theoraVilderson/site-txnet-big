package driver

import (
	"context"
	"errors"
)

// Adopter is what a family imported in place adds on its provisioning side
// (ADR-0160, F-1601-b2): a user that keeps its own login on the panel is taken
// over by us — our ceiling on it, the panel's own credit off — and can be
// handed back. Neither call ever writes, reads or replaces the login's secret:
// the customer's device keeps working through both.
//
// It is optional, so ask through AdopterOf: a paced driver hides its family's.
type Adopter interface {
	// AdoptClient puts the user under our ceiling. On User Manager: our chain
	// is linked, the user's own profiles are detached, and our claim tag goes
	// into its label last — the mark that the adoption is done, so a call that
	// died half way is finished by the next. Safe to repeat.
	AdoptClient(ctx context.Context, req AdoptRequest) error
	// ReleaseClient hands the user back as it was imported: its own profile
	// linked again before ours comes off, so it is never left without one,
	// then its own label. The user itself is never deleted. Safe to repeat.
	ReleaseClient(ctx context.Context, req ReleaseRequest) error
}

// AdoptRequest is the user to take over and the state to put it in.
type AdoptRequest struct {
	RemoteID string
	ClaimTag string
	// DataLimitBytes is the first ceiling, in the counter adoption starts:
	// on User Manager the profile link's, which starts at zero (F-1601-e).
	DataLimitBytes int64
	NoDataLimit    bool
	RateLimitBps   int64
	Enabled        bool
}

// ReleaseRequest is the user to hand back and what it held at import.
type ReleaseRequest struct {
	RemoteID string
	// Profile is the user's own profile at import (`config.adoptedProfile`).
	Profile string
	// Label is the user's own label at import (`config.adoptedLabel`).
	Label string
}

// AdopterOf is the driver's Adopter, if its family has one, looked up through
// the pacing wrapper, which paces it like any other write.
func AdopterOf(d any) (Adopter, bool) {
	if p, ok := d.(*paced); ok {
		if _, has := p.Driver.(Adopter); !has {
			return nil, false
		}
		return p, true
	}
	a, ok := d.(Adopter)
	return a, ok
}

func (p *paced) adopter(op string) (Adopter, error) {
	a, ok := p.Driver.(Adopter)
	if !ok {
		return nil, NewFault(FaultUnsupported, op, 0, errors.New("this family adopts no login in place"))
	}
	return a, nil
}

// AdoptClient is the family's Adopter, paced.
func (p *paced) AdoptClient(ctx context.Context, req AdoptRequest) error {
	return p.spend(ctx, "AdoptClient", func(ctx context.Context) error {
		a, err := p.adopter("AdoptClient")
		if err != nil {
			return err
		}
		return a.AdoptClient(ctx, req)
	})
}

// ReleaseClient is the family's Adopter, paced.
func (p *paced) ReleaseClient(ctx context.Context, req ReleaseRequest) error {
	return p.spend(ctx, "ReleaseClient", func(ctx context.Context) error {
		a, err := p.adopter("ReleaseClient")
		if err != nil {
			return err
		}
		return a.ReleaseClient(ctx, req)
	})
}
