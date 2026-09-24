package db

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"sub-service/internal/sub"
)

// Store is `/sub`'s reads against Postgres. Both are single-row lookups on a
// unique column (`tenant_domain.domainValue`, `grant.subscriptionTokenHash`).
type Store struct {
	DB Querier
}

var _ sub.Store = Store{}

// DomainByHost reads the `tenant_domain` row for a normalised host.
func (s Store) DomainByHost(ctx context.Context, host string) (sub.Domain, bool, error) {
	var d sub.Domain
	err := s.DB.QueryRow(ctx,
		`SELECT "tenantId"::text, purpose::text, "domainType"::text, "verificationStatus"::text
		   FROM tenant.tenant_domain WHERE "domainValue" = $1`, host,
	).Scan(&d.TenantID, &d.Purpose, &d.DomainType, &d.VerificationStatus)
	return d, found(err), missIsNil(err)
}

// GrantByTokenHash reads the Grant a token hash names.
func (s Store) GrantByTokenHash(ctx context.Context, hash string) (sub.Grant, bool, error) {
	var g sub.Grant
	err := s.DB.QueryRow(ctx,
		`SELECT id::text, "tenantId"::text, status::text
		   FROM entitlement."grant" WHERE "subscriptionTokenHash" = $1`, hash,
	).Scan(&g.ID, &g.TenantID, &g.Status)
	return g, found(err), missIsNil(err)
}

func found(err error) bool { return err == nil }

func missIsNil(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}
