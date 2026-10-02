import { Injectable } from '@nestjs/common';
import type { AiActionType } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { BudgetSubject } from '../attention/attention-budget.service';
import { PrismaService } from '../prisma/prisma.service';

export type OptOutVerdict = { pass: true } | { pass: false; suppressedBy: 'opt_out' };

/**
 * F-1505 / ADR-0109 point 8: "don't show me this again" — one tap, permanent,
 * per subject × action type, kept in `ai.opt_out`. Nothing in the engine
 * removes a row; only the subject's own erasure will (F-038-s).
 *
 * `verdict` is the pipeline step after the threshold. `optOutFrom` is the tap:
 * it names a message the subject received, and the action is found only as
 * that subject's, so a tap carrying someone else's action id opts out nobody.
 * It also stops what is already queued of the type — an opt-out that let the
 * next scheduled one go out would read as ignored.
 */
@Injectable()
export class OptOuts {
  constructor(private readonly prisma: PrismaService) {}

  async verdict(subject: BudgetSubject, actionType: AiActionType): Promise<OptOutVerdict> {
    const { tenantId, kind, id } = subject;
    const row = await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, (tx) =>
        tx.aiOptOut.findUnique({
          where: { tenantId_subjectKind_subjectId_actionType: { tenantId, subjectKind: kind, subjectId: id, actionType } },
          select: { createdAt: true },
        }),
      ),
    );
    return row ? { pass: false, suppressedBy: 'opt_out' } : { pass: true };
  }

  /**
   * `null`: no such action of this subject's. A second tap answers the same and changes nothing.
   * A reseller's upgrade (F-038-o4) is the reseller's, told to its owner: the owner's tap opts the
   * reseller out — found as the reseller's whose `ownerUserId` is the tapper, never any other.
   */
  async optOutFrom(subject: BudgetSubject, actionId: string, now: Date): Promise<{ actionType: AiActionType } | null> {
    const { tenantId } = subject;
    return runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        let kind = subject.kind;
        let id = subject.id;
        let action = await tx.aiAction.findFirst({
          where: { id: actionId, tenantId, subjectKind: kind, subjectId: id },
          select: { actionType: true },
        });
        if (!action && kind === 'user') {
          const resellers = await tx.aiAction.findFirst({ where: { id: actionId, tenantId, subjectKind: 'tenant' }, select: { subjectId: true, actionType: true } });
          // `tenant.tenant` has no RLS; the app pool reads it as every service does.
          const owned = resellers && (await tx.tenant.findFirst({ where: { id: resellers.subjectId, ownerUserId: id }, select: { id: true } }));
          if (resellers && owned) {
            kind = 'tenant';
            id = resellers.subjectId;
            action = { actionType: resellers.actionType };
          }
        }
        if (!action) return null;
        const { actionType } = action;
        await tx.aiOptOut.createMany({
          data: [{ tenantId, subjectKind: kind, subjectId: id, actionType, createdAt: now }],
          skipDuplicates: true,
        });
        await tx.aiAction.updateMany({ where: { id: actionId, status: 'sent' }, data: { status: 'dismissed', outcomeAt: now } });
        await tx.aiAction.updateMany({
          where: { tenantId, subjectKind: kind, subjectId: id, actionType, status: { in: ['scheduled', 'awaiting_approval'] } },
          data: { status: 'suppressed', suppressedBy: 'opt_out' },
        });
        return { actionType };
      }),
    );
  }
}
