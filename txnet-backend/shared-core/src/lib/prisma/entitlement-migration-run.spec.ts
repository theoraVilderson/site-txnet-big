import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F-201-a (D-63): the two tables a reseller's import runs on, and the key that
 * makes it idempotent. Nothing an import does writes outside them until the
 * commit, and what the commit creates carries `remoteIdentity` back.
 *
 * The failures worth a spec are the silent ones. Without a unique key on
 * `grant.remoteIdentity` per tenant, a second run over the same source panel
 * issues every user's service again and both copies serve traffic (F-207).
 * Without RLS on the run and its items, one reseller's preview lists another's
 * customers. Without the status trigger, a committed run can be previewed and
 * committed a second time. Each reads like a working system.
 *
 * Same method as `entitlement-grant-purchase-and-purge.spec.ts`: both sides are
 * read off disk, so a column dropped from one side is a red test.
 */

const DOMAINS = join(__dirname, '../../../../prisma/domains');
const MIGRATIONS = join(DOMAINS, 'migrations');
const MIGRATION_NAME = 'a_reseller_brings_its_users_from_another_panel';

const entitlement = readFileSync(join(DOMAINS, 'entitlement.prisma'), 'utf8');

/** A migration's SQL (the F-201-a one by default); empty while it does not exist yet. */
function migrationSql(migration = MIGRATION_NAME): string {
  const dir = readdirSync(MIGRATIONS).find((name) => name.endsWith(`_${migration}`));
  return dir ? readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8') : '';
}
const sql = migrationSql();

/** The body of one `model` or `enum` block. */
function block(kind: 'model' | 'enum', name: string): string {
  const found = new RegExp(`^${kind}\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(entitlement);
  if (!found) throw new Error(`entitlement.prisma declares no ${kind} ${name}`);
  return found[1];
}

/** An enum's values, in declaration order. */
function enumValues(name: string): string[] {
  return block('enum', name)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => /^[a-z][a-z0-9_]*$/.test(line));
}

describe('entitlement.migration_run: one import, its source and its state', () => {
  it('has a migration of its own', () => {
    expect(sql).not.toBe('');
  });

  it('names the three kinds and the run states D-63 lists', () => {
    expect(enumValues('MigrationRunKind')).toEqual(['panel', 'link', 'csv']);
    expect(enumValues('MigrationRunStatus')).toEqual([
      'draft',
      'previewing',
      'previewed',
      'committing',
      'committed',
      'rolled_back',
      'cancelled',
      'expired',
      // F-211: added after, so last — Postgres appends a new value.
      'rolling_back',
    ]);
  });

  it.each([
    ['tenantId', 'String'],
    ['kind', 'MigrationRunKind'],
    ['sourceFamily', 'DriverType\\?'],
    ['sourceAddress', 'String\\?'],
    ['status', 'MigrationRunStatus'],
    ['plannedCreate', 'Int'],
    ['plannedUpdate', 'Int'],
    ['plannedSkip', 'Int'],
    ['committedItems', 'Int'],
    ['failedItems', 'Int'],
    ['rollbackUntil', 'DateTime\\?'],
    ['actorUserId', 'String'],
  ])('the run declares %s', (column, type) => {
    expect(block('model', 'MigrationRun')).toMatch(new RegExp(`^\\s*${column}\\s+${type}`, 'm'));
    expect(sql).toContain(`"${column}"`);
  });

  it('refuses a status move the run does not make', () => {
    expect(sql).toContain('CREATE TRIGGER migration_run_status_moves');
    // A committed run only rolls back; it is never previewed or committed again.
    expect(sql).toMatch(/OLD\."status" = 'committed'\s+AND NEW\."status" IN \('rolled_back'\)/);
    // Since F-211 the rollback goes through `rolling_back`, a batch a tick, never in one step.
    const rollback = migrationSql('an_import_rolls_back_within_its_window');
    expect(rollback).toMatch(/OLD\."status"::text = 'committed'\s+AND NEW\."status"::text IN \('rolling_back'\)/);
    expect(rollback).toMatch(/OLD\."status"::text = 'rolling_back'\s+AND NEW\."status"::text IN \('rolled_back'\)/);
  });

  it('a panel run names its family and address; a csv run names neither', () => {
    expect(sql).toContain('migration_run_source_fits_kind');
  });

  it('only a panel run names a registered panel to read in place (F-1601-b1)', () => {
    expect(block('model', 'MigrationRun')).toMatch(/sourcePanelId\s+String\?\s+@db\.Uuid/);
    expect(migrationSql('a_run_reads_a_registered_router_in_place')).toMatch(/"migration_run_in_place_is_a_panel_run"\s+CHECK \("sourcePanelId" IS NULL OR "kind" = 'panel'\)/);
  });
});

describe('entitlement.migration_item: one source client, planned then done', () => {
  const item = block('model', 'MigrationItem');

  it.each([
    ['runId', 'String'],
    ['tenantId', 'String'],
    ['remoteIdentity', 'String'],
    ['sourceSnapshot', 'Json'],
    ['plannedAction', 'MigrationItemAction'],
    ['skipReason', 'MigrationSkipReason\\?'],
    ['outcome', 'MigrationItemOutcome'],
    ['createdUserId', 'String\\?'],
    ['createdGrantId', 'String\\?'],
    ['createdConfigIds', 'String\\[\\]'],
  ])('the item declares %s', (column, type) => {
    expect(item).toMatch(new RegExp(`^\\s*${column}\\s+${type}`, 'm'));
    expect(sql).toContain(`"${column}"`);
  });

  it('names the skip reasons F-206, F-208, a balance file (F-209-a) and a skipped inbound (LIVE-1-h) report', () => {
    expect(enumValues('MigrationItemAction')).toEqual(['create', 'update', 'skip']);
    expect(enumValues('MigrationSkipReason')).toEqual(['expired', 'duplicate', 'over_cap', 'unknown_protocol', 'unreadable', 'traffic_mismatch', 'unknown_user', 'ambiguous_user', 'currency_mismatch', 'no_inbound', 'inbound_skipped']);
  });

  it('holds one item per source client in a run, in its run’s tenant', () => {
    expect(item).toMatch(/@@unique\(\[runId, remoteIdentity\]\)/);
    expect(sql).toContain('migration_item_runId_tenantId_fkey');
  });

  it('a skip names its reason, and only a skip has one', () => {
    expect(sql).toContain('migration_item_skip_has_reason');
  });
});

describe('grant.remoteIdentity: the import’s idempotency key (F-207)', () => {
  it('is nullable and unique per tenant', () => {
    expect(block('model', 'Grant')).toMatch(/^\s*remoteIdentity\s+String\?/m);
    expect(block('model', 'Grant')).toMatch(/@@unique\(\[tenantId, remoteIdentity\]\)/);
    expect(sql).toContain('CREATE UNIQUE INDEX "grant_tenantId_remoteIdentity_key"');
  });

  it('is carried only by a migrated Grant', () => {
    expect(sql).toContain('grant_remote_identity_is_migration');
  });
});

describe('grant.importedUsedBytes: what an import’s source served (F-208)', () => {
  const baseline = migrationSql('an_import_counts_what_its_source_served');

  it('starts at 0 and is carried only by a migrated Grant', () => {
    expect(block('model', 'Grant')).toMatch(/^\s*importedUsedBytes\s+BigInt\s+@default\(0\)/m);
    expect(baseline).toContain('grant_imported_used_bytes_shape');
  });
});

describe('both tables are tenant data', () => {
  it.each(['migration_run', 'migration_item'])('%s has forced RLS and a tenant policy', (table) => {
    expect(sql).toContain(`ALTER TABLE entitlement.${table} FORCE ROW LEVEL SECURITY`);
    expect(sql).toContain(`CREATE POLICY tenant_isolation ON "entitlement"."${table}"`);
  });
});
