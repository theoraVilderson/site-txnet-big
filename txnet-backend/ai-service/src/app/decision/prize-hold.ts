import type { AiActionType, GrantStatus } from '@prisma/client';

import type { Reason } from '../profile/predictions';

/**
 * F-038-y (ADR-0111 point 2, ADR-0110): a prize the user just won, from the
 * wheel or a lottery (`engagement.reward_issue`), holds the engine's sale
 * about it. Pure — `PrizeReader` reads the records.
 *
 * - **Extra days** hold the Grant's sale until its end *before* the prize
 *   (`grant_duration_change.endsAtBefore`) passes: then the user lives on the
 *   prize, and the renewal is due again.
 * - **Bonus GB** hold it while more than the bonus is left (purchased −
 *   consumed > the prize), and only in the usage period it was won in — a
 *   renewal or a reset opens a new one (`usagePeriodStartedAt`), so a hold
 *   never silences the next renewal.
 * - Either holds nothing on a Grant that is not `active` or is past its end.
 * - An **unused prize coupon** (no use, none reserved, active, not expired,
 *   not deleted) holds every *offer* coupon: the two never stack. The
 *   renewal itself is still told — without the offer, as a season does it
 *   (F-038-r).
 *
 * A free Grant holds nothing: its renewal is the sale it exists to start.
 */

/** The sale types a prize on their Grant holds. A top-up funds the renewal, so it is one of them. */
export const PRIZE_HELD_TYPES: ReadonlySet<AiActionType> = new Set<AiActionType>(['renew', 'resize_up', 'resize_down', 'retain_offer', 'top_up_wallet']);

export type PrizeGrant = {
  id: string;
  status: GrantStatus;
  endsAt: Date | null;
  purchasedBytes: bigint;
  consumedBytes: bigint;
  usagePeriodStartedAt: Date | null;
};

export type PrizeCoupon = { id: string; usedCount: number; reservedCount: number; isActive: boolean; expiresAt: Date | null; deletedAt: Date | null };

export type PrizeRecord =
  | { kind: 'extra_days'; rewardId: string; at: Date; grant: PrizeGrant; endsAtBefore: Date }
  | { kind: 'bonus_traffic_gb'; rewardId: string; at: Date; grant: PrizeGrant; bytes: bigint }
  | { kind: 'discount_coupon'; rewardId: string; at: Date; coupon: PrizeCoupon };

/** Per Grant, the prize holding its sale; and the unused prize coupon holding any offer. */
export type PrizeHold = { grants: ReadonlyMap<string, Reason>; coupon: Reason | null };

export const NO_PRIZE_HOLD: PrizeHold = { grants: new Map(), coupon: null };

function grantHeld(r: Exclude<PrizeRecord, { kind: 'discount_coupon' }>, now: Date): boolean {
  const g = r.grant;
  const t = now.getTime();
  if (g.status !== 'active' || (g.endsAt && g.endsAt.getTime() <= t)) return false;
  if (r.kind === 'extra_days') return r.endsAtBefore.getTime() > t;
  if (g.usagePeriodStartedAt && g.usagePeriodStartedAt.getTime() > r.at.getTime()) return false;
  return g.purchasedBytes - g.consumedBytes > r.bytes;
}

function couponHeld(c: PrizeCoupon, now: Date): boolean {
  return c.usedCount === 0 && c.reservedCount === 0 && c.isActive && c.deletedAt === null && (c.expiresAt === null || c.expiresAt.getTime() > now.getTime());
}

export function prizeHold(records: readonly PrizeRecord[], now: Date): PrizeHold {
  const grants = new Map<string, Reason>();
  let coupon: Reason | null = null;
  // Newest first: the reason names the latest prize holding each.
  for (const r of [...records].sort((a, b) => b.at.getTime() - a.at.getTime())) {
    const at = r.at.toISOString();
    if (r.kind === 'discount_coupon') {
      if (!coupon && couponHeld(r.coupon, now)) coupon = { code: 'prize_coupon', rewardId: r.rewardId, couponId: r.coupon.id, at };
    } else if (!grants.has(r.grant.id) && grantHeld(r, now)) {
      grants.set(r.grant.id, { code: 'prize_held', rewardId: r.rewardId, prizeType: r.kind, grantId: r.grant.id, at });
    }
  }
  return { grants, coupon };
}

/** Why `c` is held by a prize, or null. Help (`usage_alert`, `checkout_help`) never is. */
export function heldByPrize(hold: PrizeHold | undefined, c: { actionType: AiActionType; grantId?: string | null }): Reason | null {
  if (!hold || !PRIZE_HELD_TYPES.has(c.actionType)) return null;
  const onGrant = c.grantId ? hold.grants.get(c.grantId) : undefined;
  if (onGrant) return onGrant;
  return c.actionType === 'retain_offer' ? hold.coupon : null;
}

type DueRow = { id: string; subjectKind: string; subjectId: string; actionType: string; reasons: unknown };

/**
 * At the take (F-038-g2): the ids of due user rows a prize won since their
 * decision now holds — they are stopped `prize`, never told.
 */
export function prizeStops(rows: readonly DueRow[], holds: ReadonlyMap<string, PrizeHold>): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (row.subjectKind !== 'user') continue;
    const target = ((row.reasons as Reason[] | null) ?? []).find((r) => r.code === 'suggest_variant');
    const grantId = typeof target?.['grantId'] === 'string' ? target['grantId'] : null;
    if (heldByPrize(holds.get(row.subjectId), { actionType: row.actionType as AiActionType, grantId })) out.add(row.id);
  }
  return out;
}
