import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory, Prisma } from '@prisma/client';
import { Job, JobResult } from '../automation/job';
import { accepted, gateFxDeviation } from '../currency/fx-rate.gate';
import { answered, FxRatePoller } from '../currency/fx-rate.poller';
import { reduceFxReads, reduced } from '../currency/fx-rate.reducer';
import { FxSource, fxSourcesByKey } from '../currency/fx-source';

/**
 * F-0603 / F-0604 / F-0605 — the FX worker, **off the request path** and
 * nowhere near it.
 *
 * Steps 1 to 3 of the catalog's five-step loop: every active source queried
 * concurrently with a three-second timeout (F-0603, `FxRatePoller`), then the
 * failures and the values outside the hard band discarded, `minSources`
 * required to remain, and the **median** taken (F-0604, `reduceFxReads`), then
 * a move beyond `maxDeviationPercent` refused (F-0605, `gateFxDeviation`).
 * Steps 4-5 are F-0606 (write the snapshot and cache it in Redis).
 *
 * **So this job computes and gates a rate but still publishes nothing.**
 * Nothing reads a rate from this unit until F-0606 writes the snapshot and the
 * cache entry; until then an accepted median is a number in a run log.
 *
 * **The baseline the gate compares against lives in this object, and only
 * until F-0606.** A rejected reading never becomes it — that is the whole
 * security of the gate, because a baseline that moved on a refusal could be
 * walked anywhere in 5% steps. In memory means a restart is a cold start and
 * the first poll after it is ungated, and it means two replicas gate against
 * their own histories rather than a shared one. Both are real holes and both
 * close in F-0606, which gives the last accepted rate a durable home in
 * `currency.CurrencyExchangeRate` and `fx:rate:{code}`; until that row exists
 * there is nowhere else for it to be, and a gate that only works after a boot
 * settles is worth more than no gate.
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
 *
 * A rate refused by F-0605's gate is that same `failed` run, reached by
 * returning rather than throwing so that the numbers survive into the run log —
 * they are what the alert is about. See the comment on that branch.
 */
@Injectable()
export class FxRateJob implements Job {
  readonly key = 'fx_rate_refresh';
  readonly name = 'FX rate refresh';
  readonly description =
    'Queries every active USDT/IRT order book concurrently with a 3s timeout (F-0603), discards failures and out-of-band values, takes the median of at least minSources (F-0604), and refuses a move beyond FX_MAX_DEVIATION_PERCENT since the last accepted rate (F-0605). Does not publish the rate yet — F-0606 caches it.';
  readonly category = BotWorkerCategory.data_aggregation;

  private readonly logger = new Logger(FxRateJob.name);

  /**
   * The last rate this process accepted — F-0605's baseline, and nothing else.
   * Null until the first accepted poll, which is what makes a cold start
   * ungated. **Assigned only on the accepted branch**; see the class comment.
   */
  private lastAccepted: Prisma.Decimal | null = null;

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

    const gated = gateFxDeviation(
      reduction.rialPerUsdt,
      this.lastAccepted,
      this.maxDeviationPercent(),
    );

    // A rejection is a failed run like a shortfall, but it **returns** rather
    // than throwing, and that is deliberate. A thrown error reaches
    // `bot_execution_log` as `{ error: <message> }` and nothing else — the
    // per-source readings, the median and the size of the move are all lost,
    // and those three numbers are the entire content of this alert. Returned
    // with `itemsProcessed: 0` and a non-zero `errorsCount`, `TickConsumer`
    // records exactly the same `failed` status and keeps the evidence.
    //
    // `accepted` and `rejectedDeviationPercent` are the two keys
    // `currency.rules.yml` reads, and they are why the run log needs the shape
    // rather than the status: an accepted rate with one dead exchange is
    // `partial`, not `success`, so a rule that asked the status could not tell
    // it from a refusal. Renaming either key silently disarms that alert — see
    // `docs/operations/observability.md`.
    if (!accepted(gated)) {
      this.logger.error(`FX rate rejected: ${gated.reason}`);
      return {
        itemsProcessed: 0,
        errorsCount: reduction.discarded.length + 1,
        metrics: {
          ...metrics,
          accepted: false,
          rejected: gated.reason,
          rejectedDeviationPercent: gated.deviationPercent.toNumber(),
          maxDeviationPercent: gated.maxDeviationPercent.toNumber(),
          previousRialPerUsdt: gated.previous.toString(),
        },
      };
    }

    this.lastAccepted = gated.rialPerUsdt;

    this.logger.log(
      `${reduction.used.length}/${sources.length} source(s) used, ` +
        `median ${reduction.rialPerUsdt.toString()} rial/USDT` +
        (gated.deviationPercent === null
          ? ' (cold start — no deviation gate)'
          : ` (${gated.deviationPercent.toString()}% move)`) +
        ': ' +
        reads.map((o) => `${o.source}=${o.rialPerUsdt.toString()}`).join(' '),
    );

    return {
      itemsProcessed: reduction.used.length,
      errorsCount: reduction.discarded.length,
      metrics: {
        ...metrics,
        accepted: true,
        deviationPercent:
          gated.deviationPercent === null
            ? null
            : gated.deviationPercent.toNumber(),
        previousRialPerUsdt:
          gated.previous === null ? null : gated.previous.toString(),
      },
    };
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
