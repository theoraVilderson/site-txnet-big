import { Prisma } from '@prisma/client';

/** The rate passed the gate and may be published. */
export interface FxAccepted {
  ok: true;
  rialPerUsdt: Prisma.Decimal;
  /** What it was compared against; null on a cold start. */
  previous: Prisma.Decimal | null;
  /** How far it moved, in percent. Null when there was no baseline. */
  deviationPercent: Prisma.Decimal | null;
}

/** The rate moved too far. There is no rate this poll, and somebody is told. */
export interface FxRejected {
  ok: false;
  /** The rate that was refused — kept, because the alert is about its size. */
  rialPerUsdt: Prisma.Decimal;
  previous: Prisma.Decimal;
  deviationPercent: Prisma.Decimal;
  maxDeviationPercent: Prisma.Decimal;
  reason: string;
}

export type FxGated = FxAccepted | FxRejected;

/**
 * A predicate rather than a bare `g.ok` test, for the reason `reduced` gives in
 * `fx-rate.reducer.ts`: this workspace compiles without `strictNullChecks`, and
 * in that mode a boolean discriminant does not narrow a union on the negative
 * branch.
 */
export const accepted = (g: FxGated): g is FxAccepted => g.ok;

/**
 * F-0605 — step 3 of the FX loop: **a move beyond `maxDeviationPercent`
 * (default 5%) is rejected**, and the job turns that rejection into a critical
 * alert.
 *
 * **This is a different question from F-0604's band, not a tighter version of
 * it.** The band is absolute and asks whether a number can be a price at all;
 * it has to be wide, because it has no history and this market moves. This gate
 * is relative and asks whether the price can have *moved* this far since the
 * last rate we accepted — so it is the one step that catches the failure
 * `contract.fx-worker.md` says the band deliberately cannot: a toman order book
 * read as rial. That reading is in band, every source agrees with it because
 * they are all read the same way, the median passes it through, and it is ten
 * times wrong. Against the last accepted rate it is a 90% fall, and obvious.
 *
 * **What it compares against is the last *accepted* rate, never the last
 * computed one.** That rule is the caller's to keep and it is the whole
 * security of the gate: if a rejected reading became the next baseline, two
 * polls of a broken source would walk the rate anywhere in 5% steps. This
 * function cannot get that wrong because it holds nothing — `previous` is an
 * argument, and a rejection returns a value rather than recording one.
 *
 * **A cold start accepts.** After a boot there is no previous rate, and a gate
 * that refused on principle would leave the loop unable to ever publish a
 * first one. The first rate after a restart is therefore ungated, which is a
 * real and deliberate hole: it is F-0604's quorum and band that guard it, and
 * it closes when F-0606 gives the baseline somewhere durable to live.
 *
 * **"Beyond" is strict and symmetric.** Exactly `maxDeviationPercent` is a move
 * of that size and not one beyond it, and a fall is as suspicious as a rise —
 * the unit error above arrives as a fall.
 *
 * Pure and total, like `reduceFxReads`: no clock, no config, no network, and
 * every refusal is a returned value. A gate that threw would take the loop down
 * on exactly the poll it exists to survive.
 */
export function gateFxDeviation(
  candidate: Prisma.Decimal,
  previous: Prisma.Decimal | null,
  maxDeviationPercent: Prisma.Decimal,
): FxGated {
  // A non-positive baseline is not a baseline: the deviation from zero has no
  // value and the division has no answer. Nothing should produce one — F-0604's
  // band floor is 100000 — but "should not" is not a reason to throw here.
  if (previous === null || previous.lte(0))
    return { ok: true, rialPerUsdt: candidate, previous: null, deviationPercent: null };

  const deviationPercent = candidate
    .minus(previous)
    .abs()
    .div(previous)
    .mul(100);

  if (deviationPercent.gt(maxDeviationPercent))
    return {
      ok: false,
      rialPerUsdt: candidate,
      previous,
      deviationPercent,
      maxDeviationPercent,
      reason:
        `median ${candidate.toString()} rial/USDT moved ` +
        `${deviationPercent.toString()}% from the last accepted rate ` +
        `${previous.toString()} (max ${maxDeviationPercent.toString()}%)`,
    };

  return { ok: true, rialPerUsdt: candidate, previous, deviationPercent };
}
