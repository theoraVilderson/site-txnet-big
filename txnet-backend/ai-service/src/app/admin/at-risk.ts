import { Injectable } from '@nestjs/common';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { SUGGEST_LEAD_DAYS } from '../decision/candidates';
import type { Reason } from '../profile/predictions';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 86_400_000;

/** ADR-0109 point 9's line: a renewal predicted under this is at risk — and where a discount may go (F-038-f2). */
export const AT_RISK_RENEWAL_BELOW = 0.5;

export const AT_RISK_KINDS = ['renewal', 'run_out'] as const;
export type AtRiskKind = (typeof AT_RISK_KINDS)[number];

export type AtRiskItem = {
  userId: string;
  grantId: string | null;
  /** The prediction's value as stored: a probability, or days to run-out. */
  value: string | null;
  predictedAt: string | null;
  confidence: string;
  reasons: Reason[];
};

/**
 * The reseller's at-risk lists (F-038-j1, ADR-0109 point 7), from the
 * predictions the hourly rebuild stored — the tenant's own, under RLS:
 *
 * - `renewal` — a paid Grant ending within 30 days whose renewal is predicted
 *   under 0.5, soonest end first;
 * - `run_out` — a bag predicted to run out inside the lead time (7 days).
 *
 * Each with its `reasons` (codes and numbers; the page words them). A user is
 * named by id only: `ai` reads no contact column (invariant 7), and the page
 * links to the user where the panel already shows one.
 */
@Injectable()
export class AtRisk {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, kind: AtRiskKind, cursor: string | null, take: number, now: Date): Promise<{ items: AtRiskItem[]; nextCursor: string | null }> {
    const where =
      kind === 'renewal'
        ? { tenantId, subjectKind: 'user' as const, kind: 'renewal_probability' as const, value: { lt: AT_RISK_RENEWAL_BELOW }, predictedAt: { gt: now } }
        : { tenantId, subjectKind: 'user' as const, kind: 'meter_exhaustion' as const, predictedAt: { gt: now, lte: new Date(now.getTime() + SUGGEST_LEAD_DAYS * DAY_MS) } };
    const rows = await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, (tx) =>
        tx.aiPrediction.findMany({
          where,
          orderBy: [{ predictedAt: 'asc' }, { id: 'asc' }],
          take: take + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: { id: true, subjectId: true, value: true, predictedAt: true, confidence: true, reasons: true },
        }),
      ),
    );
    const shown = rows.slice(0, take);
    return {
      items: shown.map((r) => {
        const reasons = (r.reasons as Reason[] | null) ?? [];
        const grantId = reasons[0]?.['grantId'];
        return {
          userId: r.subjectId,
          grantId: typeof grantId === 'string' ? grantId : null,
          value: r.value === null ? null : r.value.toFixed(4),
          predictedAt: r.predictedAt ? r.predictedAt.toISOString() : null,
          confidence: r.confidence.toFixed(4),
          reasons,
        };
      }),
      nextCursor: rows.length > take ? shown[shown.length - 1].id : null,
    };
  }
}
