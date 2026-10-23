package driver

import (
	"context"
	"errors"
)

// AccountsReader is what a family imported in place adds (ADR-0160,
// F-1601-a): a RADIUS panel whose users keep their own login on it. Its
// provisioning reads do not fit an import's snapshot — they read the secret
// a login is checked with, and its "inbound" is a NAS rather than what a user
// was sold — so the snapshot reads these instead:
//
//   - ListProfiles is what a user was sold there: the snapshot's inbounds,
//     each mapped to a product as an Xray import maps an inbound.
//   - ListAccounts is every user with its profile as InboundRemoteID, its
//     ceiling, rate, on/off and the profile's end — and never its secret:
//     UUID is empty, and the panel is not asked for it.
//   - ClientTotals (TotalsReader) is each user's own running total: what it
//     has used, which open sessions alone would miss.
//
// It is optional, so ask through AccountsOf: a paced driver hides its family's.
type AccountsReader interface {
	TotalsReader
	ListProfiles(ctx context.Context) ([]Inbound, error)
	ListAccounts(ctx context.Context) ([]RemoteClient, error)
}

// AccountsOf is the reader's AccountsReader, if its family has one, looked up
// through the pacing wrapper, which paces it like any other request.
func AccountsOf(r any) (AccountsReader, bool) {
	if p, ok := r.(*paced); ok {
		if _, has := p.Driver.(AccountsReader); !has {
			return nil, false
		}
		return p, true
	}
	a, ok := r.(AccountsReader)
	return a, ok
}

func (p *paced) accounts(op string) (AccountsReader, error) {
	a, ok := p.Driver.(AccountsReader)
	if !ok {
		return nil, NewFault(FaultUnsupported, op, 0, errors.New("this family is not imported in place"))
	}
	return a, nil
}

// ListProfiles is the family's AccountsReader, paced.
func (p *paced) ListProfiles(ctx context.Context) ([]Inbound, error) {
	return share(ctx, p, "ListProfiles", "ListProfiles", func(ctx context.Context) ([]Inbound, error) {
		a, err := p.accounts("ListProfiles")
		if err != nil {
			return nil, err
		}
		return a.ListProfiles(ctx)
	})
}

// ListAccounts is the family's AccountsReader, paced.
func (p *paced) ListAccounts(ctx context.Context) ([]RemoteClient, error) {
	return share(ctx, p, "ListAccounts", "ListAccounts", func(ctx context.Context) ([]RemoteClient, error) {
		a, err := p.accounts("ListAccounts")
		if err != nil {
			return nil, err
		}
		return a.ListAccounts(ctx)
	})
}
