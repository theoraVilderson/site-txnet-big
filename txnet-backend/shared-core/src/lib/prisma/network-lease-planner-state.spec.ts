import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F-027-cx: the lease planner's state lives on the tables that already exist
 * (ADR-0093 rule 4). `quotaengine/schema.sql` is reference only: its
 * `replicas` are our `config`, its `panels` our `panel`, and its
 * `subscriptions` are the Grant, whose Quota and Used the planner reads from
 * billing and the counters rather than keeping a copy that can disagree.
 *
 * What a restart must not lose is what took the planner minutes to learn: a
 * panel's tick phase and enforcement lag, and per config the pessimistic
 * limit, the unconfirmed write and the two rates. A column missing from
 * either side is a planner that boots blind, which reads as a correct run
 * with a wider overshoot — so this spec holds both sides, off disk, as
 * `network-config-desired-state.spec.ts` does.
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

const network = readFileSync(join(DOMAINS, 'network.prisma'), 'utf8');
const sql = migrationSql();

/** The body of one `model` block. */
function model(name: string): string {
  const found = new RegExp(`^model\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(network);
  if (!found) throw new Error(`the schema declares no model ${name}`);
  return found[1];
}

describe('network.panel: what the planner learns about a panel', () => {
  const panel = model('Panel');

  it.each([
    ['tickPeriodMs', 'Int\\?', 'INTEGER'],
    ['tickPhaseMask', 'BigInt\\?', 'BIGINT'],
    ['lagMeanSec', 'Float\\?', 'DOUBLE PRECISION'],
    ['lagVarianceSec2', 'Float\\?', 'DOUBLE PRECISION'],
    ['lagSamples', 'Int\\s+@default\\(0\\)', 'INTEGER NOT NULL DEFAULT 0'],
  ])('declares %s on both sides', (column, prisma, pg) => {
    expect(panel).toMatch(new RegExp(`^\\s*${column}\\s+${prisma}`, 'm'));
    expect(sql).toContain(`ADD COLUMN "${column}" ${pg}`);
  });

  it('holds the phase mask to 32 bins and the lag to a sample count', () => {
    expect(sql).toContain('panel_tick_phase_needs_period');
    expect(sql).toContain('panel_lag_matches_samples');
  });
});

describe('network.config: what the planner holds per replica', () => {
  const config = model('Config');

  it.each([
    ['limitPeakBytes', 'BigInt\\?', 'BIGINT'],
    ['writePending', 'Boolean\\s+@default\\(false\\)', 'BOOLEAN NOT NULL DEFAULT false'],
    ['rateFastBps', 'Float\\s+@default\\(0\\)', 'DOUBLE PRECISION NOT NULL DEFAULT 0'],
    ['rateSlowBps', 'Float\\s+@default\\(0\\)', 'DOUBLE PRECISION NOT NULL DEFAULT 0'],
  ])('declares %s on both sides', (column, prisma, pg) => {
    expect(config).toMatch(new RegExp(`^\\s*${column}\\s+${prisma}`, 'm'));
    expect(sql).toContain(`ADD COLUMN "${column}" ${pg}`);
  });

  it('refuses a negative peak or rate', () => {
    expect(sql).toContain('config_lease_state_not_negative');
  });
});

describe('no parallel schema (ADR-0093 rule 4)', () => {
  it.each(['replicas', 'subscriptions', 'panels', 'inbounds', 'group_inbounds', 'outbox'])(
    'creates no quotaengine table %s',
    (table) => {
      expect(sql).not.toMatch(new RegExp(`CREATE TABLE[^(]*"?${table}"?\\s*\\(`, 'i'));
    },
  );

  it('keeps no copy of a Grant quota or usage on the config', () => {
    const config = model('Config');
    expect(config).not.toMatch(/^\s*(quotaBytes|usedBytes|grantQuota|grantUsed)\s/m);
  });
});
