package db

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"sub-service/internal/sub"
)

// Store is `/sub`'s reads against Postgres: single-row lookups on a unique key
// (`tenant_domain.domainValue`, `grant.subscriptionTokenHash`, an old link's
// `legacy_sub_link` (tenant, host, path)), then the Grant's configs.
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

// grantColumns is what a render needs of a Grant (`g`), with its tenant's
// branding (`b`), whichever row named it: its `Subscription-Userinfo` (F-609)
// — the traffic limit as text (`sub.userinfo` decides what an unreadable one
// means), the sum of its unexpired `traffic_bytes` adjustments, read by
// `quota_adjustment_grantId_idx`, whether it was sold with unlimited traffic
// (F-111-s) — and its tenant's line-name template and brand name (F-307-j),
// empty with no branding row.
const grantColumns = `g.id::text, g."tenantId"::text, g.status::text, g."billingMode"::text, g."consumedBytes",
		        COALESCE(g.quotas->'traffic_bytes'->>'limit', ''),
		        COALESCE((SELECT sum(a.delta) FROM entitlement.quota_adjustment a
		                   WHERE a."grantId" = g.id AND a.metric = 'traffic_bytes'
		                     AND (a."expiresAt" IS NULL OR a."expiresAt" > now())), 0)::bigint,
		        g."endsAt", g."trafficUnlimited",
		        COALESCE(b."lineNameTemplate", ''), COALESCE(b."brandName", '')`

// grantRow reads one Grant selected with grantColumns.
func grantRow(row pgx.Row) (sub.Grant, bool, error) {
	var g sub.Grant
	err := row.Scan(&g.ID, &g.TenantID, &g.Status, &g.BillingMode, &g.ConsumedBytes,
		&g.TrafficLimit, &g.TrafficAdjustment, &g.EndsAt, &g.TrafficUnlimited,
		&g.Naming.Template, &g.Naming.Brand)
	return g, found(err), missIsNil(err)
}

// GrantByTokenHash reads the Grant a token hash names.
func (s Store) GrantByTokenHash(ctx context.Context, hash string) (sub.Grant, bool, error) {
	return grantRow(s.DB.QueryRow(ctx,
		`SELECT `+grantColumns+`
		   FROM entitlement."grant" g
		   LEFT JOIN tenant.tenant_branding b ON b."tenantId" = g."tenantId"
		  WHERE g."subscriptionTokenHash" = $1`, hash))
}

// GrantByLegacyPath reads the Grant an import kept an old link for (F-203-b),
// by `legacy_sub_link`'s unique (tenant, host, path). A deleted Grant's link
// stops answering: a `cancelled` one is no Grant here, where its token still
// gets the inactive answer (F-609).
func (s Store) GrantByLegacyPath(ctx context.Context, tenantID, host, path string) (sub.Grant, bool, error) {
	return grantRow(s.DB.QueryRow(ctx,
		`SELECT `+grantColumns+`
		   FROM entitlement.legacy_sub_link l
		   JOIN entitlement."grant" g ON g.id = l."grantId"
		   LEFT JOIN tenant.tenant_branding b ON b."tenantId" = g."tenantId"
		  WHERE l."tenantId" = $1::uuid AND l.host = $2 AND l.path = $3 AND g.status <> 'cancelled'`, tenantID, host, path))
}

// ConfigsOfGrant reads every config of a Grant with its panel's state and
// whether the panel is a drain member of the Grant's own group (F-027-bm,
// F-027-er: the Grant's, never its variant's), oldest
// first so the body's order does not change between renders. Filtering is the
// handler's (`sub.serves`), so the rule is tested without a database.
func (s Store) ConfigsOfGrant(ctx context.Context, grantID string) ([]sub.Config, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT c."panelId"::text, p."panelState"::text, c.status::text, c."desiredRemote"::text, c.uuid,
		        COALESCE(c."linksUuid", ''), c."linkLines", COALESCE(c."userLabel", ''), p.region,
		        EXISTS (SELECT 1 FROM entitlement."grant" g
		                  JOIN network.panel_group_member m ON m."groupId" = g."panelGroupId" AND m."panelId" = c."panelId"
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
		if err := rows.Scan(&c.PanelID, &c.PanelState, &c.Status, &c.DesiredRemote, &c.UUID, &c.LinksUUID, &c.LinkLines, &c.UserLabel, &c.Region, &c.Draining); err != nil {
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
