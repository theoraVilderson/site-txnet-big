import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { Job, JobResult } from '../automation/job';
import { answered, FxRatePoller } from '../currency/fx-rate.poller';
import { FxSource, fxSourcesByKey } from '../currency/fx-source';

/**
 * F-0603 — the FX worker, **off the request path** and nowhere near it.
 *
 * What this row builds is step 1 of the catalog's five-step loop: every active
 * source queried concurrently with a three-second timeout. Steps 2-5 are
 * F-0604 (discard and take the median of at least `minSources`), F-0605 (reject
 * a move beyond `maxDeviationPercent` and alert) and F-0606 (write the snapshot
 * and cache it in Redis).
 *
 * **So this job does not publish a rate yet, and does not pretend to.** What it
 * does is real and readable: a `bot_execution_log` row per run saying which
 * sources answered, what each of them said, and how long each took — which is
 * the evidence F-0604's `minSources` default of 2 has to be chosen against, and
 * the evidence D-22's open half needs. D-22 says these exchanges are reachable
 * during a national-internet shutdown *only if this process runs on a node
 * inside Iran*; where it is scheduled is `automation`'s decision and is not
 * settled, and a run log with per-source latencies is what settles it.
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
 * throw instead, and `TickConsumer` records the run as `failed` (automation
 * invariant #3) — the same rule `VaultRetentionJob` states for the same reason.
 */
@Injectable()
export class FxRateJob implements Job {
  readonly key = 'fx_rate_refresh';
  readonly name = 'FX rate refresh';
  readonly description =
    'Queries every active USDT/IRT order book concurrently with a 3s timeout (F-0603). Does not yet publish a rate — F-0604 takes the median.';
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

    const metrics = {
      sources: sources.length,
      answered: reads.length,
      perSource: Object.fromEntries(
        outcomes.map((o) => [
          o.source,
          answered(o)
            ? { rialPerUsdt: o.rialPerUsdt.toString(), latencyMs: o.latencyMs }
            : { failed: o.reason, latencyMs: o.latencyMs },
        ]),
      ),
    };

    if (reads.length === 0)
      throw new Error(
        `no FX source answered: ${outcomes.map((o) => `${o.source} (${answered(o) ? 'ok' : o.reason})`).join('; ')}`,
      );

    this.logger.log(
      `${reads.length}/${sources.length} source(s) answered: ` +
        reads.map((o) => `${o.source}=${o.rialPerUsdt.toString()}`).join(' '),
    );

    return {
      itemsProcessed: reads.length,
      errorsCount: outcomes.length - reads.length,
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
}
