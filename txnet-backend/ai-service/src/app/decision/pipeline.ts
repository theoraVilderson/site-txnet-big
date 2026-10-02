import { Injectable } from '@nestjs/common';
import { Prisma, type AiAction, type AiActionType } from '@prisma/client';
import type { QuietWindow } from '@txnet-backend/shared-core';

import type { BudgetVerdict } from '../attention/attention-budget';
import { AttentionBudget, type BudgetSubject } from '../attention/attention-budget.service';
import type { AiTenantMode } from '../policy/ai-defaults';
import { ActionLog } from './action-log';
import { candidatesFor, type CandidateInputs, type EngineCandidate } from './candidates';
import { thresholdVerdict } from './confidence-threshold';
import { CooldownReader } from './cooldown-reader';
import { Holdouts } from './holdout';
import { OfferGuardrails, offerTaken } from './offer-guardrail';
import { OptOuts } from './opt-out';
import { QuietDownReader } from './quiet-down-reader';
import { quietDownVerdict, type QuietInputs } from './quiet-down';
import { scheduleAt } from './schedule';

/** Everything one subject's decision reads besides the steps' own reads (`DecisionReader`). */
export type SubjectDecisionInputs = {
  candidates: CandidateInputs;
  /** `account_profile.activeHours`: 168 UTC hour-of-week shares, zeros when unknown. */
  activeHours: number[];
  /** The user's quiet window in their resolved zone, or none. */
  quiet: QuietWindow | null;
  /** `scheduledFor` of the subject's actions already queued, any type. */
  pendingSends: Date[];
  /** Stopped rows written in the last 24 h: a repeat of one is not written again. */
  stoppedToday: Array<{ actionType: AiActionType; suppressedBy: string | null }>;
};

/** A candidate's expected margin; help with none (`usage_alert`, F-1516) ranks as zero. */
const marginOf = (c: EngineCandidate) => new Prisma.Decimal(c.expectedMargin?.amount ?? 0);

/**
 * F-038-e / ADR-0109 point 8 — one subject, in this order:
 *
 * candidates (types the tenant runs) → threshold (F-1503) → opt-out (F-1505)
 * → cooldown (F-1504) → quiet-down (F-1506) → holdout (F-1508) → attention
 * budget (F-1501, a peek) → the highest expected **margin**, never a
 * negative one (F-038-p) → offer
 * guardrails → a time: the next active hour outside quiet hours, before the
 * deadline.
 *
 * Every candidate weighed is recorded by `ActionLog` (F-1509): one stopped
 * with the first step that stopped it, the one kept as `scheduled`. A stopped
 * row that repeats one written in the last 24 h for the same type and step is
 * not written again — the hourly run would otherwise record "holdout" 24 times
 * a day for every account in the control group, and the audit would say
 * nothing more.
 *
 * At most one suggestion is scheduled per subject per run: the attention
 * budget allows one a day, and the margin picks which.
 *
 * Text is the template (F-1540's default) even when the tenant has a model:
 * the language layer (F-1535, F-1543) is not built.
 */
@Injectable()
export class DecisionPipeline {
  constructor(
    private readonly optOuts: OptOuts,
    private readonly cooldown: CooldownReader,
    private readonly quietDown: QuietDownReader,
    private readonly holdouts: Holdouts,
    private readonly budget: AttentionBudget,
    private readonly log: ActionLog,
    private readonly offers: OfferGuardrails,
  ) {}

  async decide(subject: BudgetSubject, mode: AiTenantMode, inputs: SubjectDecisionInputs, now: Date): Promise<AiAction[]> {
    return this.decideAmong(subject, mode, candidatesFor(inputs.candidates, now), inputs, now);
  }

  /**
   * The same steps over candidates the caller proposed — a reseller's upgrade
   * (F-038-o4), whose candidate is not a user's Grant.
   */
  async decideAmong(subject: BudgetSubject, mode: AiTenantMode, proposed: EngineCandidate[], inputs: Omit<SubjectDecisionInputs, 'candidates'>, now: Date): Promise<AiAction[]> {
    const runs = new Set(mode.actionTypes);
    const candidates = proposed.filter((c) => runs.has(c.actionType));
    if (candidates.length === 0) return [];

    const written = new Set(inputs.stoppedToday.map((s) => `${s.actionType}:${s.suppressedBy}`));
    const out: AiAction[] = [];
    const stop = async (c: EngineCandidate, suppressedBy: string) => {
      const key = `${c.actionType}:${suppressedBy}`;
      if (written.has(key)) return;
      written.add(key);
      out.push(await this.log.record(subject, c, { status: 'suppressed', suppressedBy }, now));
    };

    let calm: QuietInputs | undefined;
    let room: BudgetVerdict | undefined;
    const survivors: EngineCandidate[] = [];
    for (const c of candidates) {
      const threshold = thresholdVerdict(c.confidence, mode.confidenceThreshold);
      if ('suppressedBy' in threshold) { await stop(c, threshold.suppressedBy); continue; }
      const optOut = await this.optOuts.verdict(subject, c.actionType);
      if ('suppressedBy' in optOut) { await stop(c, optOut.suppressedBy); continue; }
      const cooldown = await this.cooldown.verdict(subject, c.actionType, now);
      if ('suppressedBy' in cooldown) { await stop(c, cooldown.suppressedBy); continue; }
      calm ??= await this.quietDown.inputs(subject, now);
      const quiet = quietDownVerdict(calm, c.actionType, now);
      if ('suppressedBy' in quiet) { await stop(c, quiet.suppressedBy); continue; }
      const holdout = await this.holdouts.verdict(subject, mode.holdoutPercent);
      if ('suppressedBy' in holdout) { await stop(c, holdout.suppressedBy); continue; }
      room ??= await this.budget.peek(subject, now, inputs.pendingSends);
      if (!room.allowed) { await stop(c, 'attention_budget'); continue; }
      // A suggestion that loses the seller money is flagged and never sent (F-038-p).
      if (marginOf(c).isNegative()) { await stop(c, 'margin'); continue; }
      survivors.push(c);
    }
    if (survivors.length === 0) return out;

    // Margin, not revenue (point 8), compared as Decimal (C-02); a tie goes to the surer one.
    survivors.sort((a, b) => marginOf(b).comparedTo(marginOf(a)) || b.confidence - a.confidence);
    const [best, ...rest] = survivors;
    for (const c of rest) await stop(c, 'margin');

    if (best.offerId && !(await this.offers.allowed(subject, best.offerId, best.actionType))) {
      await stop(best, 'offer_guardrail');
      return out;
    }
    const when = { activeHours: inputs.activeHours, quiet: inputs.quiet, deadline: best.deadline ?? null, now };
    // F-038-r: inside the season's window on the plan when a slot fits there, else the ordinary slot.
    const at = (best.notBefore ? scheduleAt({ ...when, notBefore: best.notBefore, seasonEnd: best.seasonEnd }) : null) ?? scheduleAt(when);
    if (!at) {
      await stop(best, 'schedule');
      return out;
    }
    try {
      out.push(await this.log.record(subject, best, { status: 'scheduled', scheduledFor: at }, now));
    } catch (err) {
      // `action_offer_once`: another run gave this offer first (F-038-q).
      if (!best.offerId || !offerTaken(err)) throw err;
      await stop(best, 'offer_guardrail');
    }
    return out;
  }
}
