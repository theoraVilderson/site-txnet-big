import { Injectable } from '@nestjs/common';
import { TenantType } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { refusal } from '../envelope';
import type { Reason } from '../profile/predictions';
import { PrismaService } from '../prisma/prisma.service';

export const RESELLER_FORECAST_KINDS = ['quota_exhaustion', 'churn_risk'] as const;
export type ResellerForecastKind = (typeof RESELLER_FORECAST_KINDS)[number];

export type ResellerForecastItem = {
  tenantId: string;
  /** The reseller's slug, or null for one deleted since the run. */
  slug: string | null;
  /** As stored: days to run-out, or a probability. */
  value: string | null;
  predictedAt: string | null;
  confidence: string;
  reasons: Reason[];
};

/** How each list is ordered: the most urgent first. */
const ORDER = {
  quota_exhaustion: [{ predictedAt: 'asc' as const }, { id: 'asc' as const }],
  churn_risk: [{ value: 'desc' as const }, { id: 'asc' as const }],
};

/**
 * The platform owner's view of its resellers (F-038-o2, ADR-0109 point 4):
 * the `quota_exhaustion` and `churn_risk` rows the hourly run wrote in the
 * platform's tenant (F-038-o1), each with its reasons — codes and numbers the
 * page words. Any other caller is refused rather than shown an empty list,
 * which would read as "no reseller at risk".
 */
@Injectable()
export class ResellerForecasts {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, kind: ResellerForecastKind, cursor: string | null, take: number): Promise<{ items: ResellerForecastItem[]; nextCursor: string | null }> {
    // `tenant.tenant` has no RLS; the app pool reads it as every service does.
    const caller = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
    if (caller?.tenantType !== TenantType.platform_owner) throw refusal(403, 'not_platform_owner');

    const rows = await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, (tx) =>
        tx.aiPrediction.findMany({
          where: { tenantId, subjectKind: 'tenant', kind },
          orderBy: ORDER[kind],
          take: take + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: { id: true, subjectId: true, value: true, predictedAt: true, confidence: true, reasons: true },
        }),
      ),
    );
    const shown = rows.slice(0, take);
    const slugs = new Map(
      (await this.prisma.tenant.findMany({ where: { id: { in: shown.map((r) => r.subjectId) } }, select: { id: true, slug: true } })).map((t) => [t.id, t.slug]),
    );
    return {
      items: shown.map((r) => ({
        tenantId: r.subjectId,
        slug: slugs.get(r.subjectId) ?? null,
        value: r.value === null ? null : r.value.toFixed(4),
        predictedAt: r.predictedAt ? r.predictedAt.toISOString() : null,
        confidence: r.confidence.toFixed(4),
        reasons: (r.reasons as Reason[] | null) ?? [],
      })),
      nextCursor: rows.length > take ? shown[shown.length - 1].id : null,
    };
  }
}
