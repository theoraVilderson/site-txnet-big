import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';

import { Job, JobResult } from '../automation/job';
import { PrismaService } from '../prisma/prisma.service';

/** A partition's name, as `pg_inherits` reports it. */
interface PartitionRow {
  name: string;
}

/** `YYYY-MM-DD` in UTC — what every parameter below is passed as. */
const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const utcDayStart = (at: Date): Date =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

const utcMonthStart = (at: Date): Date =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));

const addDays = (from: Date, days: number): Date =>
  new Date(from.getTime() + days * 86_400_000);

const addMonths = (from: Date, months: number): Date =>
  new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1));

/** `traffic_raw_log_2026_08` -> `2026-08-01`. */
const monthOf = (partition: string): string =>
  `${partition.slice(-7).replace('_', '-')}-01`;

/**
 * The nightly rollup, and the half of network invariant 2 that had no
 * mechanism: **the daily aggregate is committed before its source raw
 * partition is dropped** (invariant 3, F-027-o).
 *
 * F-027-e made `traffic_raw_log` monthly-partitioned so that retention could be
 * `DROP PARTITION` instead of a row-wise `DELETE` competing with the collection
 * loop for the same pages. It left the job itself — so until now the partitions
 * accumulated, nothing ever wrote `traffic_daily_aggregate`, and the retention
 * rule in `data-model.md` described a thing nobody did.
 *
 * **The work is three SQL functions and this is their clock.** Not style: the
 * rollup reads across every tenant with no `app.tenant_id` bound, which FORCE
 * RLS shows as an empty table, and creating or dropping a partition is DDL that
 * `txnet_app` has no privilege for. Both are settled in
 * `20260921000900_the_rollup_commits_before_the_partition_drops` by
 * `SECURITY DEFINER`, which is also why there is no business logic here to get
 * wrong: summing a month belongs next to the rows, not across a wire.
 *
 * **A job in `worker-service`, not a timer in `metering-service`** (ADR-0027).
 * `metering-service` consumes `network.usage.#` and holds a broker, two pools
 * and nothing else (`domains/billing/contract.metering.md`); every scheduled
 * thing on this platform is a `Job` here, with the `bot_execution_log` row, the
 * tenant gates and the dead-letter drain that come with being one. This job
 * reaches its work through `PrismaService` rather than an internal HTTP seam
 * (`vault-retention.job.ts`) because the seam would be a route wrapping one
 * `SELECT` of a function the database already exposes.
 *
 * **Safe to run twice** (the `Job` contract): `roll_up_traffic` upserts and
 * *replaces* a day's totals rather than adding to them, `ensure_…_partition`
 * is idempotent, and dropping a partition that is already gone answers `NULL`.
 * Two replicas publishing two ticks is ordinary here, not exceptional.
 *
 * **It never succeeds quietly.** A refused drop throws — the database saying
 * the aggregate does not cover the partition is the one answer this job exists
 * to respect — and the run is recorded `failed` (automation invariant #3)
 * without going on to the next month. Dropping every *other* month behind a
 * month that could not be verified is how a reporting gap becomes several.
 */
@Injectable()
export class TrafficRollupJob implements Job {
  readonly key = 'network_traffic_rollup';
  readonly name = 'Nightly traffic rollup';
  readonly description =
    'Rolls raw traffic up into traffic_daily_aggregate, rolls the monthly partitions forward, and drops a raw month only once its aggregate matches (network invariant 3).';
  readonly category = BotWorkerCategory.data_aggregation;

  private readonly logger = new Logger(TrafficRollupJob.name);
  private readonly lookbackDays: number;
  private readonly retentionMonths: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.lookbackDays = config.get<number>('TRAFFIC_ROLLUP_LOOKBACK_DAYS', 3);
    this.retentionMonths = config.get<number>('TRAFFIC_RAW_RETENTION_MONTHS', 3);
  }

  async run(): Promise<JobResult> {
    const now = new Date();
    const thisMonth = utcMonthStart(now);

    // First, and blindly: a table with no partition for next month stops
    // accepting traffic at midnight on the 1st, and a collection pass that
    // cannot insert is a pass whose bytes wait in quarantine.
    const ensured: string[] = [];
    for (const month of [thisMonth, addMonths(thisMonth, 1)]) {
      ensured.push(await this.ensurePartition(month));
    }

    // The recent window, re-rolled every run. The upsert replaces a day rather
    // than adding to it, so overlapping windows cost nothing and a night the
    // job did not run is picked up by the next one without an operator.
    const today = utcDayStart(now);
    const rolledRecent = await this.rollUp(
      addDays(today, -(this.lookbackDays - 1)),
      addDays(today, 1),
    );

    const cutoff = addMonths(thisMonth, -this.retentionMonths);
    const expired = await this.expiredPartitions(cutoff);

    let rolledExpired = 0;
    const dropped: string[] = [];
    for (const partition of expired) {
      const month = new Date(`${monthOf(partition.name)}T00:00:00Z`);
      // The ordering, in the one place it can be read: the whole month is
      // rolled up immediately before the drop is asked for, so a late row that
      // landed after an earlier run is in the aggregate the drop checks.
      rolledExpired += await this.rollUp(month, addMonths(month, 1));
      const name = await this.dropPartition(month);
      if (name) {
        dropped.push(name);
        this.logger.log(`dropped network.${name}; its aggregate is committed`);
      }
    }

    return {
      itemsProcessed: rolledRecent + rolledExpired,
      errorsCount: 0,
      metrics: { ensured, rolledRecent, rolledExpired, dropped },
    };
  }

  private async ensurePartition(month: Date): Promise<string> {
    const rows = await this.prisma.$queryRaw<
      { ensure_traffic_raw_log_partition: string }[]
    >`SELECT network.ensure_traffic_raw_log_partition(${isoDay(month)}::date)`;
    return rows[0]?.ensure_traffic_raw_log_partition ?? '';
  }

  /** Half-open `[from, to)`, as the function's own guard requires. */
  private async rollUp(from: Date, to: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ roll_up_traffic: bigint }[]>`
      SELECT network.roll_up_traffic(${isoDay(from)}::date, ${isoDay(to)}::date)`;
    return Number(rows[0]?.roll_up_traffic ?? 0);
  }

  /**
   * The partitions older than the retention window, asked of the catalogue
   * rather than derived from a date: a month created by hand, or one the job
   * did not run for, is a table this has to know about and a calendar does not.
   */
  private async expiredPartitions(cutoff: Date): Promise<PartitionRow[]> {
    return this.prisma.$queryRaw<PartitionRow[]>`
      SELECT c.relname AS name
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
        JOIN pg_namespace n ON n.oid = p.relnamespace
       WHERE n.nspname = 'network'
         AND p.relname = 'traffic_raw_log'
         AND c.relname ~ '^traffic_raw_log_[0-9]{4}_[0-9]{2}$'
         AND to_date(right(c.relname, 7), 'YYYY_MM') < ${isoDay(cutoff)}::date
       ORDER BY c.relname`;
  }

  /** `null` when there was no such partition — a rerun of a drop that landed. */
  private async dropPartition(month: Date): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<
      { drop_traffic_raw_log_partition: string | null }[]
    >`SELECT network.drop_traffic_raw_log_partition(${isoDay(month)}::date)`;
    return rows[0]?.drop_traffic_raw_log_partition ?? null;
  }
}
