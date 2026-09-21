import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F-027-f gives a Grant the three things ADR-0072 needs before a metered byte
 * can move: how much has been **paid for** (`purchasedBytes`), how much has
 * been **measured** (`consumedBytes`), and what a byte **cost when it was
 * sold** (`meteredRate`, ADR-0073). ADR-0075 adds the other two — `suspendedAt`
 * starts the purge clock, and `purgeAfterDays` says how long it runs, on the
 * tenant as the setting and on the Grant as an optional override.
 *
 * The failure worth a spec is the one with no symptom. `billedBytes` already
 * existed and is the money cursor; fold purchase into it and `Σ ceilings ≤
 * purchasedBytes` (ADR-0072 rule 1) loses the column it is bounded by, so
 * ceilings are written against a number that moves for a different reason.
 * Nothing goes red — traffic is simply served past what anyone paid for.
 * The second one: a Grant suspended without `suspendedAt` can never become
 * due for purge, so its panel seats are held forever and the only evidence is
 * a licence count nobody is watching.
 *
 * Same method as `network-config-desired-state.spec.ts`: both sides are read
 * off disk, because a hand-written list would be edited by whoever forgot the
 * column, on the day they forgot it.
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

const entitlement = readFileSync(join(DOMAINS, 'entitlement.prisma'), 'utf8');
const tenant = readFileSync(join(DOMAINS, 'tenant.prisma'), 'utf8');
const sql = migrationSql();

/** The body of one `model` block in a schema file. */
function model(schema: string, name: string): string {
  const found = new RegExp(`^model\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
  if (!found) throw new Error(`no model ${name}`);
  return found[1];
}

/**
 * The columns the block purchaser, the delta consumer and the purge job read.
 * A name removed here is a job that silently stops advancing a cursor, so the
 * list is the contract between the four rows that follow this one.
 */
const GRANT_COLUMNS = ['consumedBytes', 'purchasedBytes', 'meteredRate', 'suspendedAt', 'purgeAfterDays'];

describe('entitlement.Grant buys its bytes before it serves them', () => {
  const grant = model(entitlement, 'Grant');

  it.each(GRANT_COLUMNS)('the schema declares %s', (column) => {
    expect(grant).toMatch(new RegExp(`^\\s*${column}\\s`, 'm'));
  });

  it.each(GRANT_COLUMNS)('the migration history creates %s', (column) => {
    expect(sql).toContain(`"${column}"`);
  });

  it('keeps what was purchased apart from what was billed and what was consumed', () => {
    // ADR-0072: `purchasedBytes` is what `Σ ceilings` is bounded by,
    // `billedBytes` stays the money cursor, and `consumedBytes` is what the
    // panels actually reported. Folded together, a ceiling is written against
    // a number that moves for a different reason — and nothing goes red.
    for (const column of ['billedBytes', 'purchasedBytes', 'consumedBytes']) {
      expect(grant).toMatch(new RegExp(`^\\s*${column}\\s+BigInt\\s+@default\\(0\\)`, 'm'));
    }
  });

  it('counts bytes in 64 bits and refuses a negative one', () => {
    // A 32-bit byte counter wraps at 4 GB — the RADIUS Gigawords trap
    // (ADR-0074) arriving a second time, in our own storage. A counter going
    // backward is a reset, never negative usage.
    expect(sql).toContain('grant_byte_counters_not_negative');
  });

  it('locks the metered rate at (18, 8), not at the two places money uses', () => {
    // ADR-0073: `C-02` governs *amounts*; a rate at two places can only step
    // in whole cents per GiB. Every amount derived from it is still rounded
    // to whole cents before the ledger (ADR-0072), so `C-02` is untouched.
    expect(grant).toMatch(/^\s*meteredRate\s+Decimal\?\s+@db\.Decimal\(18, 8\)/m);
    expect(sql).toContain('grant_metered_rate_not_negative');
  });

  it('carries a rate only where something is metered', () => {
    // A prepaid Grant priced per byte is a rate nobody will ever read and a
    // second, contradictory answer to what the user owes.
    expect(sql).toContain('grant_metered_rate_is_metered');
  });

  it('cannot hold a suspended Grant with no clock on it', () => {
    // ADR-0075: purge is due `purgeAfterDays` after `suspendedAt`. A
    // suspension with no timestamp is never due, so the panel seats it was
    // meant to free are held forever, silently.
    expect(grant).toMatch(/^\s*suspendedAt\s+DateTime\?/m);
    expect(sql).toContain('grant_suspended_has_a_clock');
  });

  it('gives the purge job its own scan', () => {
    // The hourly job (F-027-y) asks one question: which suspended Grants are
    // now due? Without the index that is a sequential scan of every Grant on
    // the platform, every hour.
    expect(sql).toContain('grant_status_suspendedAt_idx');
  });

  it('puts the purge window on the tenant and leaves the Grant an override', () => {
    // ADR-0075 makes it a tenant setting, read as it is now — a tenant that
    // shortens it means it for the Grants already waiting. The Grant's column
    // is null unless someone deliberately overrode this one.
    expect(model(tenant, 'Tenant')).toMatch(/^\s*purgeAfterDays\s+Int\s+@default\(7\)/m);
    expect(grant).toMatch(/^\s*purgeAfterDays\s+Int\?/m);
    expect(sql).toContain('grant_purge_days_not_negative');
    expect(sql).toContain('tenant_purge_days_not_negative');
  });
});
