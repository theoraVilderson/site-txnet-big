import { Injectable } from '@nestjs/common';
import type { AiSubjectKind } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { budgetVerdict, chargedTimes, type AttentionLimit, type MessageOrigin } from './attention-budget';

export type BudgetSubject = { tenantId: string; kind: AiSubjectKind; id: string };

export type SpendResult = { allowed: true; charged: boolean } | { allowed: false; charged: false; limit: AttentionLimit; retryAt: Date };

/**
 * The only writer of `engagement.attention_budget` (F-1501, ADR-0109 point 10).
 *
 * `spend` checks and charges in one transaction, holding the subject's row
 * lock between the two, so two decisions racing for the same subject cannot
 * both take its last slot. A refusal writes nothing.
 *
 * A `reply` to the user's own question is always allowed and never charged
 * (F-1502): it reads and writes nothing, so a spent budget can never stop an
 * answer.
 */
@Injectable()
export class AttentionBudget {
  constructor(private readonly prisma: PrismaService) {}

  async spend(subject: BudgetSubject, origin: MessageOrigin, now: Date): Promise<SpendResult> {
    if (origin === 'reply') return { allowed: true, charged: false };
    const { tenantId, kind, id } = subject;
    return runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, async (tx): Promise<SpendResult> => {
        // The row must exist before it can be locked; a first charge creates it.
        await tx.$executeRaw`
          INSERT INTO engagement.attention_budget ("tenantId", "subjectKind", "subjectId", "chargedAt", "updatedAt")
          VALUES (${tenantId}::uuid, ${kind}::"ai"."AiSubjectKind", ${id}::uuid, ARRAY[]::timestamp(3)[], ${now})
          ON CONFLICT ("tenantId", "subjectKind", "subjectId") DO NOTHING`;
        const [row] = await tx.$queryRaw<Array<{ chargedAt: Date[] }>>`
          SELECT "chargedAt" FROM engagement.attention_budget
          WHERE "tenantId" = ${tenantId}::uuid AND "subjectKind" = ${kind}::"ai"."AiSubjectKind" AND "subjectId" = ${id}::uuid
          FOR UPDATE`;
        const chargedAt = row?.chargedAt ?? [];
        const verdict = budgetVerdict(chargedAt, now);
        if ('limit' in verdict) return { allowed: false, charged: false, limit: verdict.limit, retryAt: verdict.retryAt };
        await tx.$executeRaw`
          UPDATE engagement.attention_budget SET "chargedAt" = ${chargedTimes(chargedAt, now)}::timestamp(3)[], "updatedAt" = ${now}
          WHERE "tenantId" = ${tenantId}::uuid AND "subjectKind" = ${kind}::"ai"."AiSubjectKind" AND "subjectId" = ${id}::uuid`;
        return { allowed: true, charged: true };
      }),
    );
  }
}
