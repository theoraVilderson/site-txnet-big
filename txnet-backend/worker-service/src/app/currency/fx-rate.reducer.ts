import { Prisma } from '@prisma/client';
import { answered, FxSourceOutcome } from './fx-rate.poller';

/** Why one source's reading is not in the sample the median was taken over. */
export interface FxDiscard {
  source: string;
  reason: string;
}

/** Enough sources survived; `rate` is the median of `used`. */
export interface FxReduced {
  ok: true;
  rate: Prisma.Decimal;
  /** The sources whose reading was kept, in poll order. */
  used: string[];
  discarded: FxDiscard[];
}

/** Too few survived. There is no rate this poll, and that is the answer. */
export interface FxNotEnoughSources {
  ok: false;
  reason: string;
  survivors: number;
  discarded: FxDiscard[];
}

export type FxReduction = FxReduced | FxNotEnoughSources;

/**
 * A predicate rather than a bare `r.ok` test, for the reason `answered` gives
 * one file over: this workspace compiles without `strictNullChecks`, and in
 * that mode a boolean discriminant does not narrow a union on the negative
 * branch — `tsc` rejects `r.reason` after `if (!r.ok)`. A predicate narrows in
 * every mode, so the check reads the same at every call site.
 */
export const reduced = (r: FxReduction): r is FxReduced => r.ok;

export interface FxReductionOptions {
  /** How many readings must survive before a median means anything. */
  minSources: number;
  /** The hard band, inclusive on both edges, in units of the currency per USD. */
  sanityMin: Prisma.Decimal;
  sanityMax: Prisma.Decimal;
}

/**
 * F-0604 — step 2 of the FX loop: **discard, require `minSources`, take the
 * median.** The catalog calls this single rule the thing that stops $100 of
 * service from selling for 600,000 rials because of one broken API response,
 * and each of the three parts is load-bearing on its own.
 *
 * **Discarding covers two different failures.** A source that did not answer is
 * already an `FxSourceFailure` from the poller and costs nothing. The dangerous
 * one is a source that answered a *number* that cannot be a price: an amount
 * column read as a price, a stale zero, a rial book parsed as toman. Those
 * parse, they pass every per-source check, and a mean over them destroys the
 * rate. The band is absolute and static because this step has no history to
 * compare against — relative movement is F-0605's job, and it cannot do it
 * until there is a last accepted rate, which on a cold start there is not.
 *
 * **What the band is not.** It is wide, roughly a factor of ten either side of
 * where this market has been, so it catches nonsense and not disagreement. It
 * will *not* catch a tenfold unit error on its own; `FxSource.unit` is what
 * prevents that, and F-0605's deviation gate is what notices it afterwards.
 * A band tight enough to catch a 10x error would reject the real rate the
 * first time the market moved, and this market moves.
 *
 * **`minSources` is a refusal, not a preference.** One surviving source is
 * precisely the "one broken API" this row exists to defend against, with
 * nothing left to outvote it; publishing it because it is all we have would
 * invert the rule. No rate this poll is a safe outcome — the last accepted
 * rate stays live (F-0606) and the run is recorded as failed.
 *
 * **The median, never the mean**, because the mean has no breakdown point at
 * all: one in-band but wrong reading moves it by its whole error divided by
 * the sample size, and this sample size is two to four. On an **even** sample
 * this takes the lower of the two middle readings rather than averaging them,
 * which is the same rule one step further down: an average of the two middle
 * quotes is a number no exchange published, and with two sources it is exactly
 * the mean the row forbids. The lower of the two is deterministic, is always a
 * price some exchange actually quoted — which is what F-0606's snapshot has to
 * be able to point at — and errs toward the cheaper dollar, which is the side
 * that cannot overcharge a user.
 *
 * Like the poller, this never throws: the shortfall is a value the job turns
 * into a failed run with a reason an operator can act on.
 */
export function reduceFxReads(
  outcomes: readonly FxSourceOutcome[],
  options: FxReductionOptions,
): FxReduction {
  const used: string[] = [];
  const kept: Prisma.Decimal[] = [];
  const discarded: FxDiscard[] = [];

  for (const outcome of outcomes) {
    if (!answered(outcome)) {
      discarded.push({ source: outcome.source, reason: outcome.reason });
      continue;
    }
    const rate = outcome.rate;
    if (rate.lt(options.sanityMin) || rate.gt(options.sanityMax)) {
      discarded.push({
        source: outcome.source,
        reason: `out of band: ${rate.toString()}`,
      });
      continue;
    }
    used.push(outcome.source);
    kept.push(rate);
  }

  if (kept.length < options.minSources)
    return {
      ok: false,
      reason:
        `only ${kept.length} of ${outcomes.length} source(s) produced a usable rate ` +
        `(minSources ${options.minSources}): ` +
        (discarded.map((d) => `${d.source} — ${d.reason}`).join('; ') ||
          'no source was polled'),
      survivors: kept.length,
      discarded,
    };

  return { ok: true, rate: median(kept), used, discarded };
}

/**
 * The lower middle on an even sample — see the note above; this is the whole
 * of "never the mean" and it is one line, so it is written where it can be
 * read rather than hidden behind a generic statistics helper.
 */
function median(values: readonly Prisma.Decimal[]): Prisma.Decimal {
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  return sorted[Math.floor((sorted.length - 1) / 2)];
}
