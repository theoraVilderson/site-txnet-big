import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F-027-e applies the storage shape `traffic_raw_log` was declared with and
 * never given: monthly native partitioning, a denormalized `tenantId`, a BRIN
 * index on `recordedAt`, and one unique key on the nightly rollup.
 *
 * Four things, one argument:
 *
 * - Retention here is `DROP PARTITION`, not `DELETE` (invariant 2). Without
 *   partitions that sentence has no mechanism behind it, and the highest-volume
 *   table in the platform is pruned row-wise — the vacuum bloat the schema
 *   comment was written to avoid.
 * - A partitioned table's every unique constraint must contain the partition
 *   key, so the primary key becomes `(id, recordedAt)`. That is not a naming
 *   detail: a `BIGSERIAL` alone cannot be enforced unique across partitions.
 * - `tenantId` is denormalized here for the same reason it is on `config`
 *   (invariant 6): the reporting read is per tenant, and reaching it through
 *   `config` is a join against the biggest table in the schema on every query.
 * - `traffic_daily_aggregate` had no unique key at all, so a cron rerun — a
 *   retry, an operator re-running last night — wrote a second row for the same
 *   day and doubled the reported usage, with both rows individually correct.
 *
 * There is deliberately **no** `DEFAULT` partition: see the migration.
 *
 * Same method as the other four network specs: the schema and the migration
 * history are read off disk, because a hand-written list would be edited by
 * whoever forgot the column, on the day they forgot it.
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

const schema = readFileSync(join(DOMAINS, 'network.prisma'), 'utf8');
const sql = migrationSql();

/** The body of one `model` block in `network.prisma`. */
function block(name: string): string {
  const found = new RegExp(`^model\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
  if (!found) throw new Error(`network.prisma declares no model ${name}`);
  return found[1];
}

describe('network traffic storage: a partition is dropped, a row is not deleted', () => {
  it('partitions the raw log by month on recordedAt', () => {
    // Native range partitioning is the mechanism invariant 2 names. Prisma
    // cannot express it, so the table is rebuilt by hand-written SQL.
    expect(sql).toMatch(/PARTITION BY RANGE \("recordedAt"\)/);
    expect(sql).toMatch(/PARTITION OF "network"\."traffic_raw_log"\s+FOR VALUES FROM/);
  });

  it('puts the partition key in the primary key', () => {
    // Postgres requires every unique constraint on a partitioned table to
    // contain the partition key. A bare BIGSERIAL primary key is the one
    // shape this table cannot have, and Prisma has to agree with it or the
    // next `migrate diff` proposes dropping the partitioning.
    expect(block('TrafficRawLog')).toMatch(/@@id\(\[id, recordedAt\]/);
    expect(sql).toMatch(/PRIMARY KEY \("id", "recordedAt"\)/);
  });

  it('has no default partition', () => {
    // The one partition that can never be dropped. Rows for a month nobody
    // created would live in it forever, and "retention is DROP PARTITION"
    // would quietly stop covering them. A missing month is an insert error
    // instead — loud, and the delta goes to quarantine rather than nowhere
    // (invariant 18).
    expect(sql).not.toMatch(/PARTITION OF "network"\."traffic_raw_log"\s+DEFAULT/);
  });

  it('can roll the next month forward without a migration', () => {
    // Partitions are not a one-off: a table with no partition for next month
    // stops accepting traffic at midnight on the 1st. The function is
    // idempotent so the nightly job can call it blindly.
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION "network"\."ensure_traffic_raw_log_partition"/);
  });

  it('indexes recordedAt with BRIN, not a B-tree', () => {
    // An append-only table whose physical order already follows the column:
    // BRIN is a fraction of the size of the B-tree the volume here would
    // otherwise pay for on every insert (schema comment, "section 18").
    expect(sql).toMatch(/USING BRIN \("recordedAt"\)/i);
  });

  it('carries the tenant on the row', () => {
    // Denormalized exactly as `config.tenantId` is (invariant 6): the
    // reporting read is per tenant, and reaching it through `config` is a
    // join against the largest table in the schema on every query.
    expect(block('TrafficRawLog')).toMatch(/^\s*tenantId\s+String\s+@db\.Uuid/m);
    expect(sql).toContain('traffic_raw_log_tenantId_recordedAt_idx');
  });

  it('is one aggregate row per config per day', () => {
    // The rollup had no unique key, so a cron rerun wrote a second row for
    // the same day and doubled the reported usage — with both rows
    // individually correct, which is what makes it invisible.
    expect(block('TrafficDailyAggregate')).toMatch(
      /@@unique\(\[configId, date\], map: "traffic_daily_aggregate_config_date_key"\)/,
    );
    expect(sql).toContain('traffic_daily_aggregate_config_date_key');
  });
});
