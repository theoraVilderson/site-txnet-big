import { Injectable } from '@nestjs/common';
import type { AiActionType } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { BudgetSubject } from '../attention/attention-budget.service';
import { PrismaService } from '../prisma/prisma.service';

/** An action that gave its offer to the subject: queued or told. A stopped or expired one gave nothing (F-038-f2). */
export const OFFER_GIVEN = ['scheduled', 'awaiting_approval', 'sent', 'accepted', 'dismissed'] as const;

/**
 * F-038-e, the guardrail step (ADR-0109 points 8, 9): a candidate carrying an
 * offer goes out only with an offer the tenant still runs, made for that
 * action type, and never twice to one account (F-038-f2) — re-read here at
 * the write, as the candidates were built from a read a moment older. A
 * candidate with no offer passes without a read. "Renewal without it under
 * 0.5" is the candidates' (`RETAIN_OFFER_BELOW`); the daily budget is spent
 * when billing issues the coupon (F-038-f3); the database's own once-per-account
 * rule is F-038-q.
 */
@Injectable()
export class OfferGuardrails {
  constructor(private readonly prisma: PrismaService) {}

  async allowed(subject: BudgetSubject, offerId: string, actionType: AiActionType): Promise<boolean> {
    const { tenantId } = subject;
    return runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const offer = await tx.aiOffer.findFirst({ where: { id: offerId, tenantId, isActive: true, actionType }, select: { id: true } });
        if (!offer) return false;
        const given = await tx.aiAction.findFirst({
          where: { tenantId, subjectKind: subject.kind, subjectId: subject.id, offerId, status: { in: [...OFFER_GIVEN] } },
          select: { id: true },
        });
        return given === null;
      }),
    );
  }
}
