// Package db holds this service's Postgres access: the read-only pgx pool it
// connects with, the boot-time assertions that the database is the one it was
// written against, and the two reads `/sub` makes.
package db

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// ColumnRef is one column of one table.
type ColumnRef struct {
	Schema string
	Table  string
	Column string
}

func (c ColumnRef) String() string { return c.Schema + "." + c.Table + "." + c.Column }

// RequiredColumns is every column this service reads, by schema then table.
//
// Prisma owns the schema and this service generates no migrations (ADR-0082,
// as ADR-0071 for network-service), so the overlap is asserted at boot: a
// column renamed on the TypeScript side is a refusal to start here, not every
// subscription answering 503. A row that begins reading a new column adds it
// here in the same change.
var RequiredColumns = map[string]map[string][]string{
	// Which host belongs to whom, and what it may serve (F-066-q).
	"tenant": {
		"tenant_domain": {"tenantId", "domainValue", "purpose", "domainType", "verificationStatus"},
	},
	// The Grant a token names (F-502), and its Subscription-Userinfo (F-609).
	"entitlement": {
		"grant":            {"id", "tenantId", "status", "subscriptionTokenHash", "billingMode", "consumedBytes", "quotas", "endsAt", "variantId"},
		"quota_adjustment": {"grantId", "metric", "delta", "expiresAt"},
	},
	// The Grant's configs, their stored lines and their panel's state (F-113-b).
	"network": {
		"config": {"id", "grantId", "panelId", "status", "desiredRemote", "uuid", "linkLines", "linksUuid", "createdAt"},
		"panel":  {"id", "panelState"},
		// Whether a config's panel is draining in its Grant's group (F-027-bm).
		"panel_group_member": {"groupId", "panelId", "role"},
	},
	"catalog": {
		"product_variant": {"id", "panelGroupId"},
	},
}

// MissingColumns reports every required column the database does not have,
// ordered so the refusal reads the same way twice.
func MissingColumns(required map[string]map[string][]string, present []ColumnRef) []ColumnRef {
	have := make(map[ColumnRef]struct{}, len(present))
	for _, ref := range present {
		have[ref] = struct{}{}
	}
	var missing []ColumnRef
	for schema, tables := range required {
		for table, columns := range tables {
			for _, column := range columns {
				ref := ColumnRef{Schema: schema, Table: table, Column: column}
				if _, ok := have[ref]; !ok {
					missing = append(missing, ref)
				}
			}
		}
	}
	sort.Slice(missing, func(i, j int) bool { return missing[i].String() < missing[j].String() })
	return missing
}

// Querier is the slice of the pgx pool this package needs.
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

// AssertColumns refuses the database if it is missing a column this service
// reads. It is called once, at boot, before the listener opens.
func AssertColumns(ctx context.Context, q Querier) error {
	schemas := make([]string, 0, len(RequiredColumns))
	for s := range RequiredColumns {
		schemas = append(schemas, s)
	}
	rows, err := q.Query(ctx,
		`SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_schema = ANY($1)`,
		schemas)
	if err != nil {
		return fmt.Errorf("read columns: %w", err)
	}
	defer rows.Close()

	var present []ColumnRef
	for rows.Next() {
		var ref ColumnRef
		if err := rows.Scan(&ref.Schema, &ref.Table, &ref.Column); err != nil {
			return fmt.Errorf("scan column: %w", err)
		}
		present = append(present, ref)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read columns: %w", err)
	}

	missing := MissingColumns(RequiredColumns, present)
	if len(missing) == 0 {
		return nil
	}
	names := make([]string, 0, len(missing))
	for _, ref := range missing {
		names = append(names, ref.String())
	}
	return fmt.Errorf(
		"schema is not the one this service was written against: %d column(s) missing (%s). Prisma owns the schema — run the migrations",
		len(missing), strings.Join(names, ", "))
}

// CrossTenantRole is the group role the connection must belong to. A host is
// resolved to its tenant before any tenant is known, so the per-tenant
// application role would see no `tenant_domain` row at all.
const CrossTenantRole = "txnet_cross_tenant"

// AssertCrossTenantRole refuses a connection that is not the cross-tenant role.
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
		return fmt.Errorf("connected as %q, which is not a member of %q", currentUser, CrossTenantRole)
	}
	return nil
}

// AssertReadOnly refuses a session in which a write would succeed. The pool
// sets `default_transaction_read_only`; a pooler or a connection string that
// dropped it would otherwise pass silently.
func AssertReadOnly(ctx context.Context, q Querier) error {
	var setting string
	if err := q.QueryRow(ctx, `SHOW transaction_read_only`).Scan(&setting); err != nil {
		return fmt.Errorf("read transaction_read_only: %w", err)
	}
	if setting != "on" {
		return fmt.Errorf("session is not read-only (transaction_read_only = %q): /sub never writes Postgres (ADR-0082)", setting)
	}
	return nil
}
