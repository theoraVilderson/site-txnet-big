import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { METERED_RATE_UNIT_BYTES } from '../catalog/metered-rate';

/**
 * F-027-g gives the catalog the one thing it cannot express today: a price per
 * byte. `catalog.Price` is per **variant**, `Decimal(18, 2)`, and has no
 * per-unit dimension at all — there is no way to say "$0.40 per GiB"
 * (ADR-0073).
 *
 * `metered_rate` is shaped exactly like `price`, and that shape is the point.
 * A rate row that could be edited in place would reprice traffic already sold,
 * and under ADR-0072 blocks already **bought** — the ledger and the cursor
 * would then disagree about what a byte cost, with nothing to reconcile them
 * from. So the same two triggers stand over it: history, and a child carries
 * its parent's tenant.
 *
 * The precision is the second failure worth a spec. At `(18, 2)` the smallest
 * expressible step is 1c per GiB; `C-02` governs *amounts*, and every amount
 * derived from this rate is rounded to whole cents before the ledger sees it
 * (ADR-0072), so nothing finer than two places is ever written as money.
 *
 * Same method as `entitlement-grant-purchase-and-purge.spec.ts`: both sides are
 * read off disk, because a hand-written list would be edited by whoever forgot
 * the column, on the day they forgot it.
 */

const DOMAINS = join(__dirname, '../../../../prisma/domains');
const MIGRATIONS = join(DOMAINS, 'migrations');

/** Every `migration.sql` in the history, concatenated. */
function migrationSql(): string {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return readFileSync(join(MIGRATIONS, entry.name, 'migration.sql'), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

const catalog = readFileSync(join(DOMAINS, 'catalog.prisma'), 'utf8');
const sql = migrationSql();

/** The body of one `model` block in a schema file. */
function model(schema: string, name: string): string {
  const found = new RegExp(`^model\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
  if (!found) throw new Error(`no model ${name}`);
  return found[1];
}

/**
 * What `Price` carries, and what a rate row carries for the same reasons: the
 * tenant RLS reads without a join, the variant it prices, when it starts, the
 * switch that retires it, and who wrote it.
 */
const RATE_COLUMNS = ['tenantId', 'variantId', 'rate', 'effectiveFrom', 'isActive', 'createdByAdminId'];

describe('catalog.MeteredRate — a metered variant carries its own price history', () => {
  const rate = model(catalog, 'MeteredRate');

  it.each(RATE_COLUMNS)('the schema declares %s', (column) => {
    expect(rate).toMatch(new RegExp(`^\\s*${column}\\s`, 'm'));
  });

  it('creates the table in the migration history', () => {
    expect(sql).toContain('"catalog"."metered_rate"');
  });

  it('stores the rate at (18, 8), not at the two places money uses', () => {
    // ADR-0073: at two decimal places the only expressible rates are 1c steps
    // per GiB, far coarser than real pricing needs. The repo already stores
    // rates at (18, 8) — `tenant_usage_meter.unitPrice`, `currency_exchange_rate`.
    expect(rate).toMatch(/^\s*rate\s+Decimal\s+@db\.Decimal\(18, 8\)/m);
  });

  it('refuses a rate of zero in the column, not only at the first byte (F-027-al)', () => {
    // A metered variant priced at nothing is not a free variant: nothing
    // downstream can buy a block from it, so `sizeBlock` refuses it
    // (`rate_not_priceable`) far from whoever typed the price. The CHECK is
    // the only place the two are the same act. Free metered service is a
    // quota with no rate, not a rate of zero.
    expect(sql).toContain('metered_rate_is_positive');
    expect(sql).toMatch(/CHECK \("rate" > 0\)/);
    // The `>= 0` it replaces is dropped, not left beside it.
    expect(sql).toMatch(/DROP CONSTRAINT[\s\S]{0,60}metered_rate_not_negative/);
  });

  it('is history: never deleted, and only isActive changes on it', () => {
    // The whole reason the rate is copied onto the Grant at issue is that a
    // rate row is a record of what was being offered when. An editable row
    // reprices traffic already sold and blocks already bought (ADR-0072).
    expect(sql).toContain('CREATE FUNCTION catalog.metered_rate_is_history()');
    expect(sql).toMatch(/CREATE TRIGGER metered_rate_is_history BEFORE UPDATE OR DELETE/);
  });

  it('carries its variant tenant, under the same trigger price is', () => {
    // Invariant 3. Without it a reseller prices another tenant's variant, and
    // RLS — which reads `tenantId` off this row, not through the join — shows
    // the rate to the wrong tenant.
    expect(sql).toMatch(/CREATE TRIGGER metered_rate_same_tenant[\s\S]*catalog\.same_tenant_as_parent\(\)/);
  });

  it('is found the way a price is: newest row at or before an instant', () => {
    // `priceAt` scans by (variantId, effectiveFrom DESC); resolution at sale
    // (F-027-p) asks the same question of this table.
    expect(sql).toContain('metered_rate_variantId_effectiveFrom_idx');
  });

  it('is read by a tenant the way the rest of the catalog is', () => {
    // Shared-read RLS: the platform's rows and its own. A metered rate left
    // out of the policy list is a table every tenant reads in full.
    expect(sql).toMatch(/'catalog\.metered_rate'/);
  });

  it('spells the rate unit once, in bytes', () => {
    // ADR-0073: bytes are the only stored unit, and "GB" is a rendering
    // concern. Spelled in three places it is wrong in one of them, and the
    // symptom is a bill off by a factor of 1024.
    expect(METERED_RATE_UNIT_BYTES).toBe(1024 * 1024 * 1024);
  });
});
