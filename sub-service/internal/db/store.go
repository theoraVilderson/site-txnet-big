package db

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"sub-service/internal/sub"
)

// Store is `/sub`'s reads against Postgres: two single-row lookups on a unique
// column (`tenant_domain.domainValue`, `grant.subscriptionTokenHash`), then the
// Grant's configs.
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

// GrantByTokenHash reads the Grant a token hash names, with what its
// `Subscription-Userinfo` is built from (F-609): the traffic limit as text
// (`sub.userinfo` decides what an unreadable one means) and the sum of its
// unexpired `traffic_bytes` adjustments, read by `quota_adjustment_grantId_idx`,
// and whether it was sold with unlimited traffic (F-111-s).
func (s Store) GrantByTokenHash(ctx context.Context, hash string) (sub.Grant, bool, error) {
	var g sub.Grant
	err := s.DB.QueryRow(ctx,
		`SELECT g.id::text, g."tenantId"::text, g.status::text, g."billingMode"::text, g."consumedBytes",
		        COALESCE(g.quotas->'traffic_bytes'->>'limit', ''),
		        COALESCE((SELECT sum(a.delta) FROM entitlement.quota_adjustment a
		                   WHERE a."grantId" = g.id AND a.metric = 'traffic_bytes'
		                     AND (a."expiresAt" IS NULL OR a."expiresAt" > now())), 0)::bigint,
		        g."endsAt", g."trafficUnlimited"
		   FROM entitlement."grant" g WHERE g."subscriptionTokenHash" = $1`, hash,
	).Scan(&g.ID, &g.TenantID, &g.Status, &g.BillingMode, &g.ConsumedBytes,
		&g.TrafficLimit, &g.TrafficAdjustment, &g.EndsAt, &g.TrafficUnlimited)
	return g, found(err), missIsNil(err)
}

// ConfigsOfGrant reads every config of a Grant with its panel's state and
// whether the panel is a drain member of the Grant's group (F-027-bm), oldest
// first so the body's order does not change between renders. Filtering is the
// handler's (`sub.serves`), so the rule is tested without a database.
func (s Store) ConfigsOfGrant(ctx context.Context, grantID string) ([]sub.Config, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT c."panelId"::text, p."panelState"::text, c.status::text, c."desiredRemote"::text, c.uuid,
		        COALESCE(c."linksUuid", ''), c."linkLines",
		        EXISTS (SELECT 1 FROM entitlement."grant" g
		                  JOIN catalog.product_variant v ON v.id = g."variantId"
		                  JOIN network.panel_group_member m ON m."groupId" = v."panelGroupId" AND m."panelId" = c."panelId"
		                 WHERE g.id = c."grantId" AND m.role = 'drain')
		   FROM network.config c JOIN network.panel p ON p.id = c."panelId"
		  WHERE c."grantId" = $1::uuid
		  ORDER BY c."createdAt", c.id`, grantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var configs []sub.Config
	for rows.Next() {
		var c sub.Config
		if err := rows.Scan(&c.PanelID, &c.PanelState, &c.Status, &c.DesiredRemote, &c.UUID, &c.LinksUUID, &c.LinkLines, &c.Draining); err != nil {
			return nil, err
		}
		configs = append(configs, c)
	}
	return configs, rows.Err()
}

func found(err error) bool { return err == nil }

func missIsNil(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}
