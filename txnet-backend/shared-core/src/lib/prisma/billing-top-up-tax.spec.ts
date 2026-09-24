import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F-104-ae puts tax back on the top-up (ADR-0076, superseding ADR-0038). The
 * columns `20260911000100_no_tax_on_top_up` dropped return, but not in the
 * shape they had: the rate is now a two-level setting, exactly as
 * `depositPresets` is — a gateway's own rate, NULL meaning inherit, over the
 * tenant's default on `deposit_setting`, NULL meaning no tax.
 *
 * Three failures are worth a spec:
 *
 * - **A rate that cannot say "inherit".** ADR-0038's rollback note re-adds the
 *   old `NOT NULL DEFAULT 10`, which would put a 10% tax on every gateway the
 *   day the calculator reads it, and leave no way to fall through to the
 *   tenant's default.
 * - **A receipt that re-explains itself.** `taxApplied` alone does not say
 *   which rate produced it; a later rate change must not rewrite an old
 *   receipt, so the rate is stored with the payment (ADR-0076).
 * - **Payments already recorded.** Rows written under ADR-0038 charged no tax.
 *   They must read as exactly that — `taxApplied = 0`, no rate — so the
 *   migration adds, never backfills, and a CHECK keeps "no rate" and "tax
 *   charged" from ever meeting on one row.
 *
 * Same method as `catalog-metered-rate.spec.ts`: both sides are read off disk.
 */

const DOMAINS = join(__dirname, '../../../../prisma/domains');
const MIGRATIONS = join(DOMAINS, 'migrations');
const DROPPED_BY = '20260911000100_no_tax_on_top_up';

/** Every migration directory, in the order Prisma applies them. */
const history = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function migration(name: string): string {
  try {
    return readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');
  } catch {
    return '';
  }
}

/** Every migration after the one that dropped the columns, concatenated. */
const after = history.slice(history.indexOf(DROPPED_BY) + 1).map(migration).join('\n');

const billing = readFileSync(join(DOMAINS, 'billing.prisma'), 'utf8');
const tenant = readFileSync(join(DOMAINS, 'tenant.prisma'), 'utf8');

/** The body of one `model` block in a schema file. */
function model(schema: string, name: string): string {
  const found = new RegExp(`^model\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
  if (!found) throw new Error(`no model ${name}`);
  return found[1];
}

/** Where a rate lives: the schema model, and the table the migration names. */
const RATE_HOMES: Array<[string, string, string]> = [
  ['PaymentGateway', billing, '"billing"."payment_gateway"'],
  ['TenantGatewayConfig', tenant, '"tenant"."tenant_gateway_config"'],
  ['DepositSetting', billing, '"billing"."deposit_setting"'],
  ['PaymentTransaction', billing, '"billing"."payment_transaction"'],
];

describe('taxRatePercent — a two-level rate, and the rate a receipt was charged at', () => {
  it('the migration that dropped the columns is still in the history', () => {
    // The spec reads "after" relative to it; a renamed directory would make
    // every assertion below pass against the wrong slice.
    expect(history).toContain(DROPPED_BY);
  });

  it.each(RATE_HOMES)('%s declares a nullable rate at (9, 4)', (name, schema) => {
    // Nullable is the whole design: NULL on a gateway = inherit the tenant's
    // default, NULL on the default = no tax, NULL on a payment = none charged.
    // (9, 4) is `percentageModifier`'s precision, the one percentage column
    // both gateway tables already carry.
    expect(model(schema, name)).toMatch(/^\s*taxRatePercent\s+Decimal\?\s+@db\.Decimal\(9, 4\)/m);
  });

  it.each(RATE_HOMES)('%s gets the column back in a migration after the drop', (_name, _schema, table) => {
    expect(after).toMatch(
      new RegExp(`ALTER TABLE ${table.replace(/[."]/g, '\\$&')}[^;]*ADD COLUMN "taxRatePercent" DECIMAL\\(9,4\\)[,;]`),
    );
  });

  it.each(RATE_HOMES)('%s refuses a rate outside 0..100', (_name, _schema, table) => {
    const escaped = table.replace(/[."]/g, '\\$&');
    expect(after).toMatch(
      new RegExp(`ALTER TABLE ${escaped}[^;]*CHECK \\("taxRatePercent" IS NULL OR \\("taxRatePercent" >= 0 AND "taxRatePercent" <= 100\\)\\)`),
    );
  });

  it('does not bring back the old NOT NULL DEFAULT 10', () => {
    expect(after).not.toMatch(/"taxRatePercent" DECIMAL\(\d+,\d+\) NOT NULL/);
  });
});

describe('payment_transaction.taxApplied — what was actually charged', () => {
  const payment = model(billing, 'PaymentTransaction');

  it('is money at (18, 2), defaulting to 0 so a payment recorded under ADR-0038 reads as untaxed', () => {
    expect(payment).toMatch(/^\s*taxApplied\s+Decimal\s+@default\(0\)\s+@db\.Decimal\(18, 2\)/m);
    expect(after).toMatch(/ADD COLUMN "taxApplied" DECIMAL\(18,2\) NOT NULL DEFAULT 0/);
  });

  it('is never negative, and is 0 whenever no rate was charged', () => {
    expect(after).toMatch(/CHECK \("taxApplied" >= 0\)/);
    expect(after).toMatch(/CHECK \("taxRatePercent" IS NOT NULL OR "taxApplied" = 0\)/);
  });
});
