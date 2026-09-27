// Package db holds this service's Postgres access: the pgx pool it connects
// with and the boot-time assertion that the schema it was pointed at is the
// one it was written against.
package db

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// Schema is the only Postgres schema this service touches (ADR-0071: Prisma
// owns every schema; Go reads and writes `network.*` rows and nothing else).
const Schema = "network"

// ColumnRef is one column of one table in Schema.
type ColumnRef struct {
	Table  string
	Column string
}

func (c ColumnRef) String() string {
	if strings.Contains(c.Table, ".") {
		return c.Table + "." + c.Column // a ForeignColumns table names its schema
	}
	return Schema + "." + c.Table + "." + c.Column
}

// ColumnSet is what the database actually has, as read at boot.
type ColumnSet []ColumnRef

// RequiredColumns is every `network.*` column this service depends on.
//
// Prisma owns the schema and this service generates no migrations (ADR-0071),
// so the two can only be kept honest by asserting the overlap at boot: a
// column renamed on the TypeScript side reaches this service as a query error
// in a collection loop at 03:00, which is a wrong number long before it is a
// visible failure. Here it is a refusal to start.
//
// A row that begins reading a new column adds it here in the same change.
var RequiredColumns = map[string][]string{
	// What a panel declares about itself — the driver contract's input
	// (F-027-i) and the request budget every loop holds itself to (F-027-v).
	"panel": {
		"id", "tenantId", "ownershipType", "apiBaseUrl",
		// Where users are served their links (F-027-bg).
		"clientBaseUrl",
		"driverType", "counterSemantics", "transport", "capabilities",
		"reviewState", "orphanPolicy", "panelApiCredentials",
		// Why the connection test gave no verdict (F-027-aq, ADR-0080).
		"connectionTestedAt", "connectionTestFault", "connectionTestDetail",
		// The panel a refused duplicate is (F-027-ce, ADR-0090).
		"duplicateOfPanelId",
		// What the duplicate check compares and names a suspect by (F-027-ce).
		"name", "ipAddress",
		"panelState", "blockedSince", "maxRequestsPerMinute",
		"maxLineRateBps", "observedWriteLatencyMs",
		"lastHealthyAt", "lastSuccessfulCollectionAt",
		// When its inbounds were last read (F-114-b).
		"inboundsReadAt",
		// What the lease planner learned of it (F-027-cz).
		"tickPeriodMs", "tickPhaseMask", "lagMeanSec", "lagVarianceSec2", "lagSamples",
		// Its outage history (F-027-dh).
		"outageWeight", "outageWeightAt",
	},
	// The panel's inbounds as last read, and the admin's pick (F-114-b).
	"panel_inbound": {
		"panelId", "remoteId", "tenantId", "tag", "protocol", "port", "host",
		"enabled", "goneAt", "seenAt", "sold",
	},
	// An inbound a group holds is out of the pool (F-027-ch).
	"panel_group_member_inbound": {"panelId", "inboundRemoteId"},
	// The client we meter, its desired state and its ceiling (ADR-0072).
	"config": {
		"id", "tenantId", "userId", "panelId", "grantId", "uuid", "protocol", "status",
		"remoteId", "claimTag", "credentialGroupId",
		"desiredEnabled", "desiredRemote", "enforcementState",
		"driftState", "driftRepairCount", "driftRepairedAt", "lastReconciledAt",
		"allocatedCeilingBytes", "appliedCeilingBytes", "writtenCeilingBytes", "observedRateBps",
		"ceilingAppliedAt", "walletBackedCeilingBytes",
		// The lease planner's pessimistic ceiling and its write in flight (F-027-db).
		"limitPeakBytes", "writePending", "sessionBaselineBytes",
		// The lines `/sub` renders, and the client they were read from (F-027-bj).
		"linkLines", "linksRemoteId", "linksUuid", "linksCapturedAt",
		// The first confirmation, announced once (F-111-o).
		"confirmedAt",
		// The inbound fulfilment placed it on (F-114-b).
		"inboundRemoteId",
		// Its Grant sold no limit (F-111-r).
		"trafficUnlimited",
	},
	// A Grant the lease planner closed, and what it closed on (F-027-dd).
	"lease_close": {"grantId", "quotaBytes", "expiresAt", "closedAt"},
	// Where the counter was, so that a figure going backward is a reset and
	// never negative usage (invariant 20, ADR-0074).
	"config_counter_state": {
		"id", "configId", "panelId", "counterSemantics",
		"lastUpBytes", "lastDownBytes", "lifetimeUpBytes", "lifetimeDownBytes",
		"lastObservedAt", "lastPublishedAt", "resetCount", "lastResetAt", "updatedAt",
	},
	// A figure we measured and do not believe (invariant 18: it is held or
	// quarantined, never dropped).
	"usage_delta_quarantine": {
		"id", "deltaId", "configId", "panelId", "upBytes", "downBytes",
		"observedAt", "reason", "state", "detectedAt", "resolvedAt",
	},
	"usage_hold": {
		"id", "configId", "panelId", "upBytes", "downBytes", "reason",
		"state", "heldFrom", "heldAt", "resolvedAt",
	},
	// The verdict over a whole panel's population, which halts collection
	// (F-027-ab).
	"panel_drift_event": {
		"id", "panelId", "eventType", "foreignPanelId", "affectedConfigCount",
		"observedConfigCount", "detectedAt", "collectionHalted", "acknowledgedAt",
	},
	"unattributed_usage": {
		"id", "panelId", "remoteIdentifier", "upBytes", "downBytes",
		"observationCount", "firstSeenAt", "lastSeenAt", "state",
		"attributedConfigId", "resolvedAt",
	},
	// The push side's unit of everything that can go wrong (F-027-af).
	"radius_session": {
		"id", "panelId", "nasId", "acctSessionId", "configId", "remoteIdentifier",
		"highWaterInBytes", "highWaterOutBytes", "publishedInBytes", "publishedOutBytes",
		"gigawordsSeen", "startedAt", "lastSeenAt", "closedAt", "closeReason",
		"createdAt", "updatedAt",
	},
}

// ForeignColumns is every column outside Schema this service reads, keyed
// `schema.table`. Each is an exception ADR-0094 makes to ADR-0071, read-only
// and listed here column by column so the boot assertion holds it the same
// way: the lease planner reads a Grant's bag from billing's own row, because
// a copy of it is a second figure that disagrees in a bag's last minute
// (ADR-0093 rule 4).
var ForeignColumns = map[string][]string{
	"entitlement.grant": {"id", "status", "purchasedBytes", "endsAt", "trafficUnlimited", "userId", "billingMode", "meteredRate"},
	// The metered reserve (F-027-dc, ADR-0094 amendment): what the owner's
	// balance still buys is part of the planner's Quota.
	"billing.wallet": {"ownerUserId", "cachedBalance"},
}

// MissingColumns reports every required column the database does not have,
// ordered by table then column so the refusal reads the same way twice.
func MissingColumns(required map[string][]string, present ColumnSet) []ColumnRef {
	have := make(map[ColumnRef]struct{}, len(present))
	for _, ref := range present {
		have[ref] = struct{}{}
	}

	var missing []ColumnRef
	for table, columns := range required {
		for _, column := range columns {
			ref := ColumnRef{Table: table, Column: column}
			if _, ok := have[ref]; !ok {
				missing = append(missing, ref)
			}
		}
	}
	sort.Slice(missing, func(i, j int) bool {
		if missing[i].Table != missing[j].Table {
			return missing[i].Table < missing[j].Table
		}
		return missing[i].Column < missing[j].Column
	})
	return missing
}

// Querier is the slice of the pgx pool this package needs, so that the
// assertion can be exercised against anything that answers a query.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) Row
}

// Rows and Row mirror pgx's own, narrowed to what is read here.
type Rows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
	Close()
}

// Row is one row, scanned or not at all.
type Row interface {
	Scan(dest ...any) error
}

// ReadColumns lists every column the database has in Schema, and those of
// the ForeignColumns tables under their `schema.table` name.
func ReadColumns(ctx context.Context, q Querier) (ColumnSet, error) {
	foreign := make([]string, 0, len(ForeignColumns))
	for table := range ForeignColumns {
		foreign = append(foreign, table)
	}
	rows, err := q.Query(ctx,
		`SELECT CASE WHEN table_schema = $1 THEN table_name ELSE table_schema || '.' || table_name END, column_name
		   FROM information_schema.columns
		  WHERE table_schema = $1 OR table_schema || '.' || table_name = ANY($2::text[])`,
		Schema, foreign)
	if err != nil {
		return nil, fmt.Errorf("read %s columns: %w", Schema, err)
	}
	defer rows.Close()

	var present ColumnSet
	for rows.Next() {
		var ref ColumnRef
		if err := rows.Scan(&ref.Table, &ref.Column); err != nil {
			return nil, fmt.Errorf("scan %s column: %w", Schema, err)
		}
		present = append(present, ref)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read %s columns: %w", Schema, err)
	}
	return present, nil
}

// AssertColumns refuses the database if it is missing a column this service
// depends on. It is called once, at boot, before anything reads a row.
func AssertColumns(ctx context.Context, q Querier) error {
	present, err := ReadColumns(ctx, q)
	if err != nil {
		return err
	}
	missing := append(MissingColumns(RequiredColumns, present), MissingColumns(ForeignColumns, present)...)
	if len(missing) == 0 {
		return nil
	}

	names := make([]string, 0, len(missing))
	for _, ref := range missing {
		names = append(names, ref.String())
	}
	return fmt.Errorf(
		"schema is not the one this service was written against: %d column(s) missing (%s). Prisma owns the schema (ADR-0071) — run the migrations, do not add them here",
		len(missing), strings.Join(names, ", "))
}

// AssertCrossTenantRole refuses a connection that is not the cross-tenant
// role. The collector spans every tenant, so it connects as a role whose
// `cross_tenant` policy is `USING (true)` — never with `BYPASSRLS`, and never
// as the per-tenant application role, which would show it one tenant's rows
// and let it report that as the platform's traffic.
func AssertCrossTenantRole(ctx context.Context, q Querier) error {
	var currentUser string
	var isMember bool
	err := q.QueryRow(ctx,
		`SELECT current_user, pg_has_role(current_user, $1, 'member')`, CrossTenantRole,
	).Scan(&currentUser, &isMember)
	if err != nil {
		return fmt.Errorf("read connection role: %w", err)
	}
	if !isMember {
		return fmt.Errorf(
			"connected as %q, which is not a member of %q — this service reads every tenant's rows and has no per-tenant scope to fall back on (ADR-0071)",
			currentUser, CrossTenantRole)
	}
	return nil
}

// CrossTenantRole is the group role the connection must belong to.
const CrossTenantRole = "txnet_cross_tenant"
