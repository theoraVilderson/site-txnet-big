import { Injectable } from '@nestjs/common';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { AiReaderPrisma } from '../prisma/prisma.service';
import { NO_PRIZE_HOLD, prizeHold, type PrizeHold, type PrizeRecord } from './prize-hold';

const HELD_KINDS = ['bonus_traffic_gb', 'extra_days', 'discount_coupon'] as const;

/**
 * F-038-y: the prizes holding each user's sales (`prize-hold.ts`), read
 * through `txnet_ai_reader` (invariant 7, `20261003000900_ai_prize_inputs`) in
 * the caller's tenant scope: `engagement.reward_issue`, then what each became
 * — its Grant, its duration change or quota adjustment, its coupon.
 *
 * Only a prize on an `active` Grant, or a coupon prize, is read; a coupon
 * used or expired is dropped at its own read. Coupons are found by the
 * reward, never by `coupon_allowed_user` (no `tenantId`, not granted).
 */
@Injectable()
export class PrizeReader {
  constructor(private readonly reader: AiReaderPrisma) {}

  async holds(tenantId: string, userIds: string[], now: Date): Promise<Map<string, PrizeHold>> {
    const out = new Map<string, PrizeHold>();
    if (userIds.length === 0) return out;
    const records = await runWithTenant({ id: tenantId }, () => tenantTransaction(this.reader, async (tx) => {
      // One after the other: an interactive transaction is one connection.
      const grants = await tx.grant.findMany({
        where: { userId: { in: userIds }, status: 'active' },
        select: { id: true, status: true, endsAt: true, purchasedBytes: true, consumedBytes: true, usagePeriodStartedAt: true },
      });
      const rewards = await tx.rewardIssue.findMany({
        where: {
          userId: { in: userIds },
          prizeType: { in: [...HELD_KINDS] },
          OR: [{ grantId: { in: grants.map((g) => g.id) } }, { couponId: { not: null } }],
        },
        select: { id: true, userId: true, prizeType: true, grantId: true, durationChangeId: true, quotaAdjustmentId: true, couponId: true, createdAt: true },
      });
      const coupons = await tx.coupon.findMany({
        where: { id: { in: rewards.flatMap((r) => (r.couponId ? [r.couponId] : [])) }, usedCount: 0, isActive: true, deletedAt: null, expiresAt: { gt: now } },
        select: { id: true, usedCount: true, reservedCount: true, isActive: true, expiresAt: true, deletedAt: true },
      });
      const changes = await tx.grantDurationChange.findMany({
        where: { id: { in: rewards.flatMap((r) => (r.durationChangeId ? [r.durationChangeId] : [])) } },
        select: { id: true, endsAtBefore: true },
      });
      const adjustments = await tx.quotaAdjustment.findMany({
        where: { id: { in: rewards.flatMap((r) => (r.quotaAdjustmentId ? [r.quotaAdjustmentId] : [])) } },
        select: { id: true, delta: true },
      });
      return { grants, coupons, rewards, changes, adjustments };
    }));

    const byUser = new Map<string, PrizeRecord[]>();
    for (const r of records.rewards) {
      const grant = records.grants.find((g) => g.id === r.grantId);
      const base = { rewardId: r.id, at: r.createdAt };
      let record: PrizeRecord | null = null;
      if (r.prizeType === 'extra_days' && grant) {
        const change = records.changes.find((c) => c.id === r.durationChangeId);
        if (change) record = { kind: 'extra_days', ...base, grant, endsAtBefore: change.endsAtBefore };
      } else if (r.prizeType === 'bonus_traffic_gb' && grant) {
        const adjustment = records.adjustments.find((a) => a.id === r.quotaAdjustmentId);
        if (adjustment) record = { kind: 'bonus_traffic_gb', ...base, grant, bytes: adjustment.delta };
      } else if (r.prizeType === 'discount_coupon') {
        const coupon = records.coupons.find((c) => c.id === r.couponId);
        if (coupon) record = { kind: 'discount_coupon', ...base, coupon };
      }
      if (record) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), record]);
    }
    for (const id of userIds) out.set(id, byUser.has(id) ? prizeHold(byUser.get(id) as PrizeRecord[], now) : NO_PRIZE_HOLD);
    return out;
  }
}
