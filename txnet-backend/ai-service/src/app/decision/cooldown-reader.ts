import { Injectable } from '@nestjs/common';
import type { AiActionType } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { BudgetSubject } from '../attention/attention-budget.service';
import { PrismaService } from '../prisma/prisma.service';
import { COOLDOWN_MS, COOLDOWN_STATUSES, cooldownVerdict, type CooldownVerdict } from './cooldown';

/**
 * F-1504: the cooldown over `ai.action`, the audit of every suggestion — the
 * engine's own table, read on the writer pool under the subject's tenant.
 * Reads only what can still hold the type: anything pending, and what was
 * sent inside the window.
 */
@Injectable()
export class CooldownReader {
  constructor(private readonly prisma: PrismaService) {}

  async verdict(subject: BudgetSubject, actionType: AiActionType, now: Date): Promise<CooldownVerdict> {
    const { tenantId, kind, id } = subject;
    const since = new Date(now.getTime() - COOLDOWN_MS);
    const past = await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, (tx) =>
        tx.aiAction.findMany({
          where: {
            tenantId,
            subjectKind: kind,
            subjectId: id,
            actionType,
            status: { in: [...COOLDOWN_STATUSES] },
            OR: [{ status: { in: ['scheduled', 'awaiting_approval'] } }, { sentAt: { gt: since } }, { sentAt: null, createdAt: { gt: since } }],
          },
          select: { status: true, sentAt: true, createdAt: true },
        }),
      ),
    );
    return cooldownVerdict(past, now);
  }
}
