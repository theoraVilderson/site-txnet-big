import { Injectable } from '@nestjs/common';
import { Prisma, type AiAction, type AiActionType } from '@prisma/client';
import { currencyPlacesOf, roundConverted, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { BudgetSubject } from '../attention/attention-budget.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * F-1509: every AI message is labelled and auditable. `ai.action` is the
 * audit, and `ActionLog.record` its only writer: every candidate the engine
 * weighed gets a row — a stopped one with the step that stopped it — so a
 * reseller can read what the engine wanted to say and why, not only what it
 * said.
 *
 * The type switch is re-read in the same transaction as the write: a type the
 * tenant switched off while the candidate was being decided is recorded as
 * stopped by `type_disabled`, never queued.
 */

/** What delivery shows beside every engine message (ADR-0109 point 11). Never omitted. */
export const SUGGESTION_LABEL = 'suggestion';

export type ActionCandidate = {
  actionType: AiActionType;
  confidence: number;
  /** Non-empty: a suggestion always says why (invariant 2). */
  reasons: Prisma.InputJsonValue[];
  templateKey: string;
  predictionId?: string;
  offerId?: string;
  /** C-02: an amount travels with its currency. */
  expectedMargin?: { amount: string; currencyCode: string };
  deadline?: Date;
};

export type ActionOutcome =
  | { status: 'suppressed'; suppressedBy: string }
  | { status: 'scheduled'; scheduledFor: Date }
  | { status: 'awaiting_approval'; renderedText: string };

@Injectable()
export class ActionLog {
  constructor(private readonly prisma: PrismaService) {}

  async record(subject: BudgetSubject, candidate: ActionCandidate, outcome: ActionOutcome, now: Date): Promise<AiAction> {
    if (candidate.reasons.length === 0) throw new Error('ai.action: a candidate with no reasons cannot be recorded');
    if (candidate.expectedMargin && !candidate.expectedMargin.currencyCode) {
      throw new Error('ai.action: an expected margin needs its currency (C-02)');
    }
    const { tenantId, kind, id } = subject;
    return runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const setting = await tx.aiSetting.findUnique({ where: { tenantId }, select: { disabledActionTypes: true } });
        const switchedOff = outcome.status !== 'suppressed' && !!setting?.disabledActionTypes.includes(candidate.actionType);
        const final: ActionOutcome = switchedOff ? { status: 'suppressed', suppressedBy: 'type_disabled' } : outcome;
        // An expected margin is an estimate (a probability times a price) until it is written here, as
        // money in its currency: rounded once, to that currency's places (ADR-0153 point 1).
        const margin = candidate.expectedMargin;
        const expectedMargin = margin ? roundConverted(new Prisma.Decimal(margin.amount), await currencyPlacesOf(tx, margin.currencyCode)) : null;
        return tx.aiAction.create({
          data: {
            tenantId,
            subjectKind: kind,
            subjectId: id,
            actionType: candidate.actionType,
            status: final.status,
            suppressedBy: final.status === 'suppressed' ? final.suppressedBy : null,
            confidence: candidate.confidence,
            reasons: candidate.reasons,
            predictionId: candidate.predictionId ?? null,
            offerId: candidate.offerId ?? null,
            templateKey: candidate.templateKey,
            renderedBy: final.status === 'awaiting_approval' ? 'model' : 'template',
            renderedText: final.status === 'awaiting_approval' ? final.renderedText : null,
            expectedMargin,
            expectedMarginCurrency: candidate.expectedMargin?.currencyCode ?? null,
            scheduledFor: final.status === 'scheduled' ? final.scheduledFor : null,
            deadline: candidate.deadline ?? null,
            createdAt: now,
          },
        });
      }),
    );
  }
}

type DueAction = Pick<
  AiAction,
  'id' | 'tenantId' | 'subjectKind' | 'subjectId' | 'actionType' | 'status' | 'templateKey' | 'renderedBy' | 'renderedText'
>;

/**
 * The envelope delivery (F-038-g) sends: always labelled, always naming its
 * action — the id the "don't show me this again" tap (F-1505) and the outcome
 * (F-038-i) come back with. Only a `scheduled` action is due to go out.
 */
export function labelledMessage(action: DueAction) {
  if (action.status !== 'scheduled') throw new Error(`ai.action ${action.id}: only a scheduled action goes out (is ${action.status})`);
  return {
    actionId: action.id,
    tenantId: action.tenantId,
    subjectKind: action.subjectKind,
    subjectId: action.subjectId,
    actionType: action.actionType,
    label: SUGGESTION_LABEL,
    templateKey: action.templateKey,
    renderedBy: action.renderedBy,
    text: action.renderedText,
  };
}
