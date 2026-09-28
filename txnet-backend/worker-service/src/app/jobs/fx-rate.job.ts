import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory, Prisma } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { accepted, gateFxDeviation } from '../currency/fx-rate.gate';
import { answered, FxFetches, FxRatePoller } from '../currency/fx-rate.poller';
import { reduceFxReads, reduced } from '../currency/fx-rate.reducer';
import { FxRateSnapshotStore } from '../currency/fx-rate.snapshot';
import { FX_DOMESTIC_CODE, fxCurrencies, fxCurrencyConfig } from '../currency/fx-currencies';

/**
 * F-0603 / F-0604 / F-0605 / F-0606-a — the FX worker, **off the request
 * path** and
 * nowhere near it.
 *
 * Steps 1 to 4 of the catalog's five-step loop, per currency since F-116-i: every active source queried
 * concurrently with a three-second timeout (F-0603, `FxRatePoller`), then the
 * failures and the values outside the hard band discarded, `minSources`
 * required to remain, and the **median** taken (F-0604, `reduceFxReads`), then
 * a move beyond `maxDeviationPercent` refused (F-0605, `gateFxDeviation`), and
 * then — F-0606-a, `FxRateSnapshotStore` — an append-only snapshot written and
 * the rate cached under `fx:rate:{code}`. Step 5 is F-0606-b, in `billing`.
 *
 * **So this job now publishes.** An accepted median stops being a number in a
 * run log and becomes a `currency.CurrencyExchangeRate` row with an id, which
 * is the row ADR-0019 requires before anything can be priced in rial.
 *
 * **The baseline the gate compares against is that snapshot, not this
 * object's memory.** A rejected reading never becomes it — that is the whole
 * security of the gate, because a baseline that moved on a refusal could be
 * walked anywhere in 5% steps. Holding it in memory meant a restart was a cold
 * start (and the first poll after one ungated), and that two replicas gated
 * against their own histories; both closed here, because
 * `FxRateSnapshotStore.lastAccepted` reads one shared, durable value. It is
 * read at the top of every run rather than cached in a field on purpose: a
 * field would reintroduce the per-replica history this row removed.
 *
 * The run log is the other half of the point: a `bot_execution_log` row per run
 * saying which sources answered, what each of them said, which were discarded
 * and why, and how long each took. It is the evidence the `minSources` default
 * of 2 and the band's edges have to be judged against, and the evidence D-22's
 * open half needs. D-22 says these exchanges are reachable during a
 * national-internet shutdown *only if this process runs on a node inside Iran*;
 * where it is scheduled is `automation`'s decision and is not settled, and a
 * run log with per-source latencies is what settles it.
 *
 * **Every five minutes is a `bot_schedule` row, not a constant in here.** The
 * worker registers itself as `fx_rate_refresh` on boot (`WorkerRegistryService`)
 * and an admin gives it a five-minute `cron_expression` schedule through
 * `/auth/workers` (F-031-b) — the exact expression is in
 * `docs/domains/currency/contract.fx-worker.md`, because a cron string cannot
 * be written inside a block comment without ending it. That is the existing
 * mechanism and it needs no
 * change: `AUTOMATION_TICK_INTERVAL_MS` defaults to 60s, so a five-minute
 * occurrence is found by the publisher well inside its own interval.
 *
 * **Safe to run twice** (the `Job` contract), in the sense that matters: a
 * second run writes a second snapshot rather than corrupting the first, and
 * that snapshot is a genuine second reading of the market. The rate table is a
 * history of what was quoted and when, not a set of distinct values, so a
 * duplicate reading is a row and not a conflict — and the second run's gate
 * compares against the first, so an accidental double tick cannot move the
 * rate any further than one tick could.
 *
 * **It does not succeed quietly.** A poll where every source failed returns the
 * same "0 processed" shape as a poll of an empty source list, and both look
 * healthy in a run log next to a real poll that simply found nothing new. Both
 * throw instead, and so does a poll where fewer than `minSources` readings
 * survived the band: `TickConsumer` records the run as `failed` (automation
 * invariant #3) — the same rule `VaultRetentionJob` states for the same reason.
 * A shortfall is not a degraded success. One surviving source *is* the broken
 * API F-0604 exists to defend against, with nothing left to outvote it.
 *
 * A rate refused by F-0605's gate is that same `failed` run, reached by
 * returning rather than throwing so that the numbers survive into the run log —
 * they are what the alert is about. See the comment on that branch.
 *
 * **F-116-i: the loop runs once per currency** (ADR-0098 part 8, D-51) —
 * `FX_CURRENCIES`, each with its own sources, band, median, gate and snapshot
 * (`fx-currencies.ts`). IRR runs first, alone, because an Iranian market's rial
 * price of a euro is only a euro rate once divided into **this tick's
 * accepted** USDT/IRT; the other currencies then run concurrently. Each
 * currency's shortfall, refusal or error is that currency's: it is recorded
 * under `metrics.currencies[code]` and the others carry on. So since F-116-i a
 * shortfall **returns** too, like a refusal, and keeps its numbers; the run is
 * `failed` only when no currency published (`itemsProcessed: 0`), `partial`
 * when some did not.
 */
/** What one currency's loop left in the run log, and whether it published. */
interface FxCurrencyRun {
  code: string;
  metrics: Record<string, unknown>;
  errors: number;
  /** The rate the snapshot holds, when this currency published one. */
  published: Prisma.Decimal | null;
}

@Injectable()
export class FxRateJob implements Job {
  readonly key = 'fx_rate_refresh';
  readonly name = 'FX rate refresh';
  readonly description =
    'For every currency in FX_CURRENCIES (IRR first): queries its sources concurrently with a 3s timeout (F-0603), discards failures and out-of-band values, takes the median of at least minSources (F-0604), refuses a move beyond FX_MAX_DEVIATION_PERCENT since that currency\'s last accepted rate (F-0605), and writes an append-only snapshot cached under fx:rate:{code} (F-0606-a, F-116-i).';
  readonly category = BotWorkerCategory.data_aggregation;
  /** Unscheduled, no rate is ever refreshed and every Toman figure goes stale. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '*/5 * * * *' };

  private readonly logger = new Logger(FxRateJob.name);

  constructor(
    private readonly config: ConfigService,
    private readonly poller: FxRatePoller,
    private readonly snapshots: FxRateSnapshotStore,
  ) {}

  async run(): Promise<JobResult> {
    const codes = fxCurrencies(this.config);
    const runs: FxCurrencyRun[] = [];
    // One download per URL for the whole run (F-116-i2): tgju's table and the
    // central banks' serve twenty currencies each, and are fetched once.
    const fetches: FxFetches = new Map();

    // IRR alone and first: its accepted rate is what every `rial-per-unit`
    // source of the other currencies divides into — this tick's, never an
    // older one, and never one the gate refused.
    let rialPerUsdt: Prisma.Decimal | null = null;
    if (codes[0] === FX_DOMESTIC_CODE) {
      const irr = await this.rate(FX_DOMESTIC_CODE, null, fetches);
      runs.push(irr);
      rialPerUsdt = irr.published;
    }
    // The rest concurrently, so their books are readings of one moment.
    runs.push(
      ...(await Promise.all(
        codes
          .filter((c) => c !== FX_DOMESTIC_CODE)
          .map((c) => this.rate(c, rialPerUsdt, fetches)),
      )),
    );

    const published = runs.filter((r) => r.published).map((r) => r.code);
    return {
      // Zero published with errors is `failed`, some is `partial`
      // (`TickConsumer.statusOf`): a currency without a rate is never quiet.
      itemsProcessed: published.length,
      errorsCount: runs.reduce((n, r) => n + r.errors, 0),
      metrics: {
        published,
        // `currency_fx` in postgres-queries.yaml reads `accepted` and
        // `rejectedDeviationPercent` from each entry, labelled by its code.
        // Renaming either silently disarms `currency.rules.yml` — see
        // `docs/operations/observability.md`.
        currencies: Object.fromEntries(runs.map((r) => [r.code, r.metrics])),
      },
    };
  }

  /**
   * One currency's loop. Never throws: a config error, a shortfall, a refusal
   * or a missing `currency` row is this currency's failure, recorded with
   * whatever numbers it got to, and costs no other currency its rate.
   */
  private async rate(
    code: string,
    rialPerUsdt: Prisma.Decimal | null,
    fetches: FxFetches,
  ): Promise<FxCurrencyRun> {
    const failed = (metrics: Record<string, unknown>, reason: string, errors = 1): FxCurrencyRun => {
      this.logger.error(`${code}: ${reason}`);
      return { code, metrics: { ...metrics, failed: reason }, errors, published: null };
    };

    let currency: ReturnType<typeof fxCurrencyConfig>;
    try {
      currency = fxCurrencyConfig(this.config, code);
    } catch (err) {
      return failed({}, reasonOf(err));
    }

    const outcomes = await this.poller.poll(currency.sources, rialPerUsdt, fetches);
    const reads = outcomes.filter(answered);
    const reduction = reduceFxReads(outcomes, {
      minSources: this.config.get<number>('FX_MIN_SOURCES', 2),
      sanityMin: currency.sanityMin,
      sanityMax: currency.sanityMax,
    });

    const metrics = {
      sources: currency.sources.length,
      answered: reads.length,
      used: reduced(reduction) ? reduction.used.length : 0,
      rate: reduced(reduction) ? reduction.rate.toString() : null,
      discarded: Object.fromEntries(
        reduction.discarded.map((d) => [d.source, d.reason]),
      ),
      perSource: Object.fromEntries(
        outcomes.map((o) => [
          o.source,
          answered(o)
            ? { rate: o.rate.toString(), latencyMs: o.latencyMs }
            : { failed: o.reason, latencyMs: o.latencyMs },
        ]),
      ),
    };

    // A poll that cannot produce a rate is a failure, not a quiet one
    // (automation invariant #3). The reducer's reason names every source and
    // what happened to it, which is the difference between an operator fixing
    // an exchange and an operator reading "too few sources" once a day.
    if (!reduced(reduction))
      return failed(
        metrics,
        `no ${code} rate this poll: ${reduction.reason}`,
        reduction.discarded.length + 1,
      );

    try {
      // The baseline, read fresh from the shared store every run. Not held in
      // a field: a field is the per-replica history F-0606-a exists to remove.
      const gated = gateFxDeviation(
        reduction.rate,
        await this.snapshots.lastAccepted(code),
        this.maxDeviationPercent(),
      );

      // A rejection keeps its numbers — the per-source readings, the median
      // and the size of the move are the entire content of the alert. An
      // accepted rate with one dead exchange is `partial`, so the alert reads
      // `accepted`, never the run's status.
      if (!accepted(gated)) {
        this.logger.error(`${code} FX rate rejected: ${gated.reason}`);
        return {
          code,
          errors: reduction.discarded.length + 1,
          published: null,
          metrics: {
            ...metrics,
            accepted: false,
            rejected: gated.reason,
            rejectedDeviationPercent: gated.deviationPercent.toNumber(),
            maxDeviationPercent: gated.maxDeviationPercent.toNumber(),
            previousRate: gated.previous.toString(),
          },
        };
      }

      // Step 4. The snapshot is written before anything claims the rate is
      // live, and it is what the *next* run's baseline will be read from.
      const out = await this.snapshots.publish(code, gated.rate);

      this.logger.log(
        `${code}: ${reduction.used.length}/${currency.sources.length} source(s) used, ` +
          `median ${reduction.rate.toString()} per USD` +
          (gated.deviationPercent === null
            ? ' (cold start — no deviation gate)'
            : ` (${gated.deviationPercent.toString()}% move)`) +
          `, snapshot ${out.snapshot.id}: ` +
          reads.map((o) => `${o.source}=${o.rate.toString()}`).join(' '),
      );

      return {
        code,
        // A snapshot that is durable but uncached is a degraded run, not a
        // healthy one: every reader goes to the table until the next poll
        // rewrites the key, and nothing else would ever say so.
        errors: reduction.discarded.length + (out.cached ? 0 : 1),
        published: new Prisma.Decimal(out.snapshot.rate),
        metrics: {
          ...metrics,
          accepted: true,
          snapshotId: out.snapshot.id,
          cached: out.cached,
          deviationPercent:
            gated.deviationPercent === null
              ? null
              : gated.deviationPercent.toNumber(),
          previousRate:
            gated.previous === null ? null : gated.previous.toString(),
        },
      };
    } catch (err) {
      return failed(metrics, reasonOf(err), reduction.discarded.length + 1);
    }
  }

  /**
   * F-0605's band, read at run time like the rest — and a string in config for
   * the reason the sanity band is one (C-02): it is compared against money.
   */
  private maxDeviationPercent(): Prisma.Decimal {
    return new Prisma.Decimal(
      this.config.get<string>('FX_MAX_DEVIATION_PERCENT', '5'),
    );
  }
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
