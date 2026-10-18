/**
 * The step logic the wheel and lottery wizards share (UX-3-c, UX-3-d): a form
 * whose check is `{ fields, prizes, overall }` — `validateWheelForm`'s and
 * `validateLotteryForm`'s shape — is cut into steps, each holding some fields
 * or the prize list. The rules stay in the form's own validator.
 */

type Errors<K extends string> = Partial<Record<K, string>>;

/** A whole-form check as both prize forms' validators return it. */
export interface PrizeFormCheck<F extends string, P extends string> {
  ok: boolean;
  fields: Errors<F>;
  prizes: Array<Errors<P>>;
  /** A rule over the whole prize list (too few, too many, the average over the cap). */
  overall: string | null;
}

/** What one step asks for: some of the form's fields, or the prizes and their whole-list rule. */
export type StepHolds<F extends string> = readonly F[] | "prizes";

/** The check cut to one step: its fields' errors, or the prizes' — nothing from another step. */
export function stepCheck<F extends string, P extends string>(check: PrizeFormCheck<F, P>, holds: StepHolds<F>): PrizeFormCheck<F, P> {
  if (holds === "prizes") {
    const ok = check.overall === null && check.prizes.every((p) => Object.keys(p).length === 0);
    return { ok, fields: {}, prizes: check.prizes, overall: check.overall };
  }
  const fields: Errors<F> = {};
  for (const k of holds) if (check.fields[k]) fields[k] = check.fields[k];
  return { ok: Object.keys(fields).length === 0, fields, prizes: [], overall: null };
}

/** The first step whose part of the check fails — where a refused review sends the admin back to. */
export function firstFailingStep<S extends string, F extends string, P extends string>(
  check: PrizeFormCheck<F, P>,
  plan: Partial<Record<S, StepHolds<F>>>,
): S | null {
  return (Object.keys(plan) as S[]).find((s) => {
    const holds = plan[s];
    return holds !== undefined && !stepCheck(check, holds).ok;
  }) ?? null;
}

/** The step a billing refusal belongs to, by its `reason`; `null` keeps it on the review. */
export function refusalStepOf<S extends string>(map: Partial<Record<string, S>>, e: unknown): S | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" ? (map[reason] ?? null) : null;
}
