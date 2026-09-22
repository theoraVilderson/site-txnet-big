import { ConfigService } from '@nestjs/config';
import { TrafficRollupJob } from './traffic-rollup.job';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The invariant this job exists for is an **ordering**, not a computation:
 * *the daily aggregate is committed before its source raw partition is
 * dropped* (network invariant 3). Get it backwards and the loss is permanent
 * and silent — `DROP TABLE` on a partition leaves nothing to recompute from,
 * and the month simply reads as zero traffic ever after.
 *
 * So what is asserted here is the sequence of calls, in order, and the
 * refusal: a drop that the database rejects because the rollup does not cover
 * the partition must fail the run (`TickConsumer` records it, automation
 * invariant #3) and must not go on to drop the next month. A job that logged
 * the refusal and carried on would drop every *other* month behind a month it
 * could not verify.
 *
 * The coverage check itself lives in `network.drop_traffic_raw_log_partition`
 * and is the database's to enforce — see
 * `20260921000900_the_rollup_commits_before_the_partition_drops`. This spec
 * holds the caller to calling it in the right order and to not swallowing its
 * answer.
 */
describe('TrafficRollupJob', () => {
  /** One recorded `$queryRaw` call: the SQL with its parameters spliced in. */
  type Call = string;

  const config = (over: Record<string, unknown> = {}) =>
    ({
      get: <T>(key: string, fallback: T): T =>
        (key in over ? (over[key] as T) : fallback),
    }) as unknown as ConfigService;

  /**
   * A Prisma double that behaves like the client in the one way this job uses
   * it: `$queryRaw` is a tagged template. The SQL is flattened with its
   * parameters in place so a call reads the way the database sees it, and
   * `partitions` decides what the catalogue query answers.
   */
  const quoted = (value: unknown) =>
    typeof value === 'string' ? `'${value}'` : String(value);

  const prismaWith = (
    partitions: string[],
    onDrop: (month: string) => void = () => undefined,
  ) => {
    const calls: Call[] = [];
    const $queryRaw = vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.reduce(
          // Rendered the way the database sees a parameter, so an assertion
          // below reads as the SQL that ran.
          (acc, part, i) =>
            acc + part + (i < values.length ? quoted(values[i]) : ''),
          '',
        );
        calls.push(sql.replace(/\s+/g, ' ').trim());

        if (sql.includes('pg_inherits')) return partitions.map((name) => ({ name }));
        if (sql.includes('drop_traffic_raw_log_partition')) {
          const month = String(values[0]);
          onDrop(month);
          return [{ drop_traffic_raw_log_partition: `traffic_raw_log_${month.slice(0, 7).replace('-', '_')}` }];
        }
        if (sql.includes('roll_up_traffic')) return [{ roll_up_traffic: BigInt(2) }];
        if (sql.includes('ensure_traffic_raw_log_partition'))
          return [{ ensure_traffic_raw_log_partition: 'traffic_raw_log_2026_09' }];
        return [];
      },
    );
    return { prisma: { $queryRaw } as unknown as PrismaService, calls };
  };

  const at = (iso: string) => vi.setSystemTime(new Date(iso));

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rolls a month up before dropping that month, never after', async () => {
    at('2026-12-15T03:15:00Z');
    const { prisma, calls } = prismaWith(['traffic_raw_log_2026_08']);
    const job = new TrafficRollupJob(prisma, config({ TRAFFIC_RAW_RETENTION_MONTHS: 3 }));

    await job.run();

    const rolled = calls.findIndex((c) => c.includes("roll_up_traffic('2026-08-01'"));
    const dropped = calls.findIndex((c) => c.includes('drop_traffic_raw_log_partition'));
    expect(rolled).toBeGreaterThanOrEqual(0);
    expect(dropped).toBeGreaterThanOrEqual(0);
    expect(rolled).toBeLessThan(dropped);
  });

  it('asks for the month it is about to drop, not for some other window', async () => {
    at('2026-12-15T03:15:00Z');
    const { prisma, calls } = prismaWith(['traffic_raw_log_2026_08']);
    await new TrafficRollupJob(prisma, config()).run();

    // The whole month, half-open: a rollup of part of it would leave the rest
    // uncovered and the drop would (correctly) refuse.
    expect(calls).toContainEqual(
      expect.stringContaining("roll_up_traffic('2026-08-01'::date, '2026-09-01'::date)"),
    );
    expect(calls).toContainEqual(
      expect.stringContaining("drop_traffic_raw_log_partition('2026-08-01'::date)"),
    );
  });

  it('stops at a partition the database refuses to drop, and drops no later month', async () => {
    at('2026-12-15T03:15:00Z');
    const { prisma, calls } = prismaWith(
      ['traffic_raw_log_2026_07', 'traffic_raw_log_2026_08'],
      (month) => {
        if (month.startsWith('2026-07'))
          throw new Error(
            'network.traffic_raw_log_2026_07 has 4 (configId, date) group(s) with no matching traffic_daily_aggregate row',
          );
      },
    );
    const job = new TrafficRollupJob(prisma, config());

    await expect(job.run()).rejects.toThrow(/traffic_daily_aggregate/);
    expect(calls.filter((c) => c.includes('drop_traffic_raw_log_partition'))).toHaveLength(1);
    expect(calls).not.toContainEqual(
      expect.stringContaining("drop_traffic_raw_log_partition('2026-08-01'::date)"),
    );
  });

  it('ensures this month and the next one before anything else', async () => {
    // A table with no partition for next month stops accepting traffic at
    // midnight on the 1st. The call is idempotent, so it is made blindly.
    at('2026-12-31T03:15:00Z');
    const { prisma, calls } = prismaWith([]);
    await new TrafficRollupJob(prisma, config()).run();

    expect(calls[0]).toContain("ensure_traffic_raw_log_partition('2026-12-01'::date)");
    expect(calls[1]).toContain("ensure_traffic_raw_log_partition('2027-01-01'::date)");
  });

  it('rolls up a recent window every run, so a missed night repairs itself', async () => {
    at('2026-12-15T03:15:00Z');
    const { prisma, calls } = prismaWith([]);
    await new TrafficRollupJob(prisma, config({ TRAFFIC_ROLLUP_LOOKBACK_DAYS: 3 }));
    await new TrafficRollupJob(prisma, config({ TRAFFIC_ROLLUP_LOOKBACK_DAYS: 3 })).run();

    // Three days back, up to and including today: the upsert replaces a day's
    // row rather than adding to it, so re-rolling a day already rolled is the
    // same answer and a night the job did not run is picked up by the next.
    expect(calls).toContainEqual(
      expect.stringContaining("roll_up_traffic('2026-12-13'::date, '2026-12-16'::date)"),
    );
  });

  it('keeps the months inside the retention window', async () => {
    at('2026-12-15T03:15:00Z');
    const { prisma, calls } = prismaWith([]);
    await new TrafficRollupJob(prisma, config({ TRAFFIC_RAW_RETENTION_MONTHS: 3 })).run();

    // The catalogue query is what decides, and it is asked for partitions
    // strictly older than the cutoff — December minus three months.
    expect(calls).toContainEqual(expect.stringContaining("'2026-09-01'::date"));
    expect(calls.filter((c) => c.includes('drop_traffic_raw_log_partition'))).toHaveLength(0);
  });
});
