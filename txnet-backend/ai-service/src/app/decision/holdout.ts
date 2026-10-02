import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { BudgetSubject } from '../attention/attention-budget.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * F-1508 / ADR-0109 points 8, 10: a permanent control group per tenant that
 * the engine never speaks to, so a suggestion's effect can be measured
 * against accounts that got none (F-038-i). The share is `holdoutPercent`,
 * 10 by default, 5–20 and never 0 (CHECK `setting_holdout_range`; clamped here
 * too, so no caller can run without one).
 *
 * Membership is a hash of the subject id — the same account lands on the same
 * side every run, in any process — and is recorded in `ai.holdout` the first
 * time it is drawn. A recorded member stays one: lowering the share releases
 * nobody, because an account that sat in the control group and then starts
 * hearing suggestions belongs to neither side of the comparison. Raising it
 * draws more.
 */

export const HOLDOUT_MIN_PERCENT = 5;
export const HOLDOUT_MAX_PERCENT = 20;

export type HoldoutVerdict = { pass: true } | { pass: false; suppressedBy: 'holdout' };

/** 0–99, stable for a subject id: the first four bytes of its SHA-256. */
export function holdoutBucket(subjectId: string): number {
  return createHash('sha256').update(subjectId).digest().readUInt32BE(0) % 100;
}

@Injectable()
export class Holdouts {
  constructor(private readonly prisma: PrismaService) {}

  async verdict(subject: BudgetSubject, holdoutPercent: number): Promise<HoldoutVerdict> {
    const { tenantId, kind, id } = subject;
    const share = Math.min(HOLDOUT_MAX_PERCENT, Math.max(HOLDOUT_MIN_PERCENT, holdoutPercent));
    return runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, async (tx): Promise<HoldoutVerdict> => {
        const recorded = await tx.aiHoldout.findUnique({
          where: { tenantId_subjectKind_subjectId: { tenantId, subjectKind: kind, subjectId: id } },
          select: { assignedAt: true },
        });
        if (recorded) return { pass: false, suppressedBy: 'holdout' };
        if (holdoutBucket(id) >= share) return { pass: true };
        await tx.aiHoldout.createMany({ data: [{ tenantId, subjectKind: kind, subjectId: id }], skipDuplicates: true });
        return { pass: false, suppressedBy: 'holdout' };
      }),
    );
  }
}
