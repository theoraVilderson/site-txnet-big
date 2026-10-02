import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { ResellerForecasts } from './reseller-forecast';

/**
 * F-038-o2 (ADR-0109 point 4): the platform owner's list of resellers by quota
 * run-out and churn risk, from the rows the hourly run wrote (F-038-o1).
 *
 * The failures worth a spec: a reseller reading the list (it would be empty,
 * but the refusal must say so, not pass as "nobody at risk"); a list mixing in
 * the platform's own users' predictions; the wrong order — a run-out next
 * month above one tomorrow, a churn risk of 0.2 above 0.9; a reseller shown by
 * id alone when its slug is known.
 */

const PLATFORM = '00000000-0000-4000-8000-0000000000f1';
const RESELLER_A = '00000000-0000-4000-8000-0000000000a1';
const RESELLER_B = '00000000-0000-4000-8000-0000000000b1';
const NOW = new Date('2026-10-02T12:00:00Z');
const DAY = 86_400_000;

function fake(rows: unknown[], tenantType: 'platform_owner' | 'reseller' = 'platform_owner') {
  const tx = { $executeRaw: vi.fn(async () => 1), aiPrediction: { findMany: vi.fn(async () => rows) } };
  const prisma = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    tenant: {
      findUnique: vi.fn(async () => ({ tenantType })),
      findMany: vi.fn(async () => [{ id: RESELLER_A, slug: 'alpha' }, { id: RESELLER_B, slug: 'beta' }]),
    },
  } as unknown as PrismaService;
  return { forecasts: new ResellerForecasts(prisma), tx, prisma };
}

const row = (over: Record<string, unknown>) => ({
  id: 'p1', subjectId: RESELLER_A, value: new Prisma.Decimal('2.5'), predictedAt: new Date(NOW.getTime() + 2.5 * DAY),
  confidence: new Prisma.Decimal('0.9'), reasons: [{ code: 'quota_rate', meter: 'campaign_sends_daily_max' }], ...over,
});

describe('ResellerForecasts (F-038-o2)', () => {
  it('answers the platform owner only — a reseller is refused, not shown an empty list', async () => {
    const { forecasts, tx } = fake([], 'reseller');
    await expect(forecasts.list(RESELLER_A, 'quota_exhaustion', null, 50)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.aiPrediction.findMany).not.toHaveBeenCalled();
  });

  it('quota run-out: the resellers\' rows only, soonest first, each named by its slug with its reasons', async () => {
    const { forecasts, tx } = fake([row({})]);
    const page = await forecasts.list(PLATFORM, 'quota_exhaustion', null, 50);
    expect(tx.aiPrediction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: PLATFORM, subjectKind: 'tenant', kind: 'quota_exhaustion' },
      orderBy: [{ predictedAt: 'asc' }, { id: 'asc' }],
      take: 51,
    }));
    expect(page).toEqual({
      items: [{
        tenantId: RESELLER_A, slug: 'alpha', value: '2.5000', predictedAt: new Date(NOW.getTime() + 2.5 * DAY).toISOString(),
        confidence: '0.9000', reasons: [{ code: 'quota_rate', meter: 'campaign_sends_daily_max' }],
      }],
      nextCursor: null,
    });
  });

  it('churn risk: the highest first', async () => {
    const { forecasts, tx } = fake([]);
    await forecasts.list(PLATFORM, 'churn_risk', null, 50);
    expect(tx.aiPrediction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: PLATFORM, subjectKind: 'tenant', kind: 'churn_risk' },
      orderBy: [{ value: 'desc' }, { id: 'asc' }],
    }));
  });

  it('pages with a cursor; a reseller deleted since the run is shown by id, slug null', async () => {
    const gone = '00000000-0000-4000-8000-0000000000c1';
    const { forecasts, tx } = fake([row({ id: 'p1' }), row({ id: 'p2', subjectId: gone }), row({ id: 'p3' })]);
    const page = await forecasts.list(PLATFORM, 'quota_exhaustion', 'p0', 2);
    expect(tx.aiPrediction.findMany).toHaveBeenCalledWith(expect.objectContaining({ cursor: { id: 'p0' }, skip: 1, take: 3 }));
    expect(page.items.map((i) => [i.tenantId, i.slug])).toEqual([[RESELLER_A, 'alpha'], [gone, null]]);
    expect(page.nextCursor).toBe('p2');
  });
});
