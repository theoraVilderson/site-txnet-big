import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory, Prisma } from '@prisma/client';
import { Job, JobResult } from '../automation/job';
import { answered, FxRatePoller } from '../currency/fx-rate.poller';
import { reduceFxReads, reduced } from '../currency/fx-rate.reducer';
import { FxSource, fxSourcesByKey } from '../currency/fx-source';

/**
 * F-0603 / F-0604 — the FX worker, **off the request path** and nowhere near
 * it.
 *
 * Steps 1 and 2 of the catalog's five-step loop: every active source queried
 * concurrently with a three-second timeout (F-0603, `FxRatePoller`), then the
 * failures and the values outside the hard band discarded, `minSources`
 * required to remain, and the **median** taken (F-0604, `reduceFxReads`).
 * Steps 3-5 are F-0605 (reject a move beyond `maxDeviationPercent` and alert)
 * and F-0606 (write the snapshot and cache it in Redis).
 *
 * **So this job computes a rate but still publishes nothing.** Nothing reads a
 * rate from this unit until F-0606 writes the snapshot and the cache entry;
 * until then the median is a number in a run log. That is deliberate — a rate
 * anything is priced from must go through F-0605's deviation gate first, and
 * that gate does not exist yet.
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
 * `/admin/workers` (F-031-b) — the exact expression is in
 * `docs/domains/currency/contract.fx-worker.md`, because a cron string cannot
 * be written inside a block comment without ending it. That is the existing
 * mechanism and it needs no
 * change: `AUTOMATION_TICK_INTERVAL_MS` defaults to 60s, so a five-minute
 * occurrence is found by the publisher well inside its own interval.
 *
 * **Safe to run twice** (the `Job` contract): it reads four public endpoints
 * and writes nothing.
 *
 * **It does not succeed quietly.** A poll where every source failed returns the
 * same "0 processed" shape as a poll of an empty source list, and both look
 * healthy in a run log next to a real poll that simply found nothing new. Both
 * throw instead, and so does a poll where fewer than `minSources` readings
 * survived the band: `TickConsumer` records the run as `failed` (automation
 * invariant #3) — the same rule `VaultRetentionJob` states for the same reason.
 * A shortfall is not a degraded success. One surviving source *is* the broken
 * API F-0604 exists to defend against, with nothing left to outvote it.
 */
@Injectable()
export class FxRateJob implements Job {
  readonly key = 'fx_rate_refresh';
  readonly name = 'FX rate refresh';
  readonly description =
    'Queries every active USDT/IRT order book concurrently with a 3s timeout (F-0603), discards failures and out-of-band values, and takes the median of at least minSources (F-0604). Does not publish the rate yet — F-0605 gates it and F-0606 caches it.';
  readonly category = BotWorkerCategory.data_aggregation;

  private readonly logger = new Logger(FxRateJob.name);

  constructor(
    private readonly config: ConfigService,
    private readonly poller: FxRatePoller,
  ) {}

  async run(): Promise<JobResult> {
    const sources = this.active();
    const outcomes = await this.poller.poll(sources);
    const reads = outcomes.filter(answered);
    const reduction = reduceFxReads(outcomes, this.reduction());

    const metrics = {
      sources: sources.length,
      answered: reads.length,
      used: reduced(reduction) ? reduction.used.length : 0,
      rialPerUsdt: reduced(reduction) ? reduction.rialPerUsdt.toString() : null,
      discarded: Object.fromEntries(
        reduction.discarded.map((d) => [d.source, d.reason]),
      ),
      perSource: Object.fromEntries(
        outcomes.map((o) => [
          o.source,
          answered(o)
            ? { rialPerUsdt: o.rialPerUsdt.toString(), latencyMs: o.latencyMs }
            : { failed: o.reason, latencyMs: o.latencyMs },
        ]),
      ),
    };

    // A poll that cannot produce a rate is a failed run, not a quiet one
    // (automation invariant #3). The reducer's reason names every source and
    // what happened to it, which is the difference between an operator fixing
    // an exchange and an operator reading "too few sources" once a day.
    if (!reduced(reduction))
      throw new Error(`no FX rate this poll: ${reduction.reason}`);

    this.logger.log(
      `${reduction.used.length}/${sources.length} source(s) used, ` +
        `median ${reduction.rialPerUsdt.toString()} rial/USDT: ` +
        reads.map((o) => `${o.source}=${o.rialPerUsdt.toString()}`).join(' '),
    );

    return {
      itemsProcessed: reduction.used.length,
      errorsCount: reduction.discarded.length,
      metrics,
    };
  }

  /**
   * Read at run time, not at boot, for the reason `VaultRetentionJob` gives: a
   * job's own configuration being wrong must cost that job its runs and leave
   * every other job in this process running.
   */
  private active(): FxSource[] {
    const configured = this.config
      .get<string>('FX_SOURCES', '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);

    if (configured.length === 0)
      throw new Error('FX_SOURCES is empty — no source to poll');

    return fxSourcesByKey(configured);
  }

  /**
   * The band and the quorum, read at run time for the same reason as the
   * source list. All three are config because all three are judgements about a
   * market rather than facts about this code: `open-questions.md` records that
   * the band's edges are this repo's estimate, chosen wide enough to catch
   * nonsense and never disagreement.
   */
  private reduction() {
    return {
      minSources: this.config.get<number>('FX_MIN_SOURCES', 2),
      sanityMinRial: new Prisma.Decimal(
        this.config.get<string>('FX_SANITY_MIN_RIAL', '100000'),
      ),
      sanityMaxRial: new Prisma.Decimal(
        this.config.get<string>('FX_SANITY_MAX_RIAL', '10000000'),
      ),
    };
  }
}
