import { randomInt } from 'node:crypto';

import { CouponChannel, CouponVisibility, DiscountType, GrantSource, GrantStatus, Prisma, RewardSource, SpinPrizeType, VariantBillingMode } from '@prisma/client';
import { moneyText, percentText } from '@txnet-backend/shared-core';

import { issueGrantByAdmin } from '../entitlement/admin-issue';
import { changeGrantDuration } from '../entitlement/duration';
import { GrantService } from '../entitlement/grant';
import { adjustGrantTraffic } from '../entitlement/traffic';
import { GIFT_CODE_ALPHABET } from '../payment/coupon-admin/coupon-batch.service';
import { bytesOfGb } from '../payment/gift/grant-traffic.schema';
import { giftGrantBytes } from '../traffic/gift-bytes';

/**
 * The reward issuer (F-707-b, ADR-0111 point 2): what a wheel slot or a
 * lottery prize gives, delivered in the caller's transaction — the spin or the
 * delivery and its prize commit together or not at all.
 *
 * Four kinds, none of them cash and none transferable:
 *
 * - **bonus GB** on the user's active Grant: a prepaid bag through
 *   `adjustGrantTraffic`, a metered one through `giftGrantBytes` as the
 *   reseller's own gift (F-311-l: a reseller's Grant buys it wholesale);
 * - **extra days** on an active Grant that has an end (`changeGrantDuration`);
 * - a **personal coupon**, cloned from one of the tenant's templates as an AI
 *   offer's is (ADR-0110): single-use, this user only, percent the lower of
 *   the template's and the prize's, the template's fixed amount as its cap;
 * - a **free Grant** of a variant (`issueGrantByAdmin`), inside a reseller's
 *   own limits on services handed out (F-019-p, F-019-o).
 *
 * GB and days need an `active` Grant now: with none it is refused, never
 * queued — a prize waiting for a purchase would be a prize for buying. Which
 * Grant: the one the caller names, else the user's prize service (F-707-r)
 * while it is active and can take the prize, else the one that runs longest
 * (no end first), so the prize is not lost with a Grant about to close.
 *
 * **Once per (source, referenceId)** — a spin attempt or a lottery winner row.
 * A retry answers what was given with `replay: true`; the same reference for
 * another user or prize is `reference_reused`. The `reward_issue` row is that
 * key, and the record of what the prize became.
 */
export type RewardRefusal = 'no_cash' | 'no_active_grant' | 'grant_not_eligible' | 'coupon_template_unavailable' | 'reference_reused';

export class RewardRefused extends Error {
  constructor(readonly reason: RewardRefusal, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
  }
}

/** The columns a wheel slot and a lottery prize share. */
export type RewardPrize = {
  prizeType: SpinPrizeType;
  prizeValue: Prisma.Decimal;
  couponTemplateId: string | null;
  couponValidDays: number | null;
  variantId: string | null;
};

export type RewardIssued = {
  rewardId: string;
  prizeType: SpinPrizeType;
  /** A retry of a reference already given: nothing moved this time. */
  replay: boolean;
  /** The Grant the GB or days went to, or the free Grant. */
  grantId: string | null;
  /** The service GB or days went to, named as My services names it, so the user is told where (F-707-y); `null` for any other prize. */
  service: PrizeServiceName | null;
  coupon: { id: string; code: string; percent: string; expiresAt: Date } | null;
};

/** The buyer's own name for a service (F-307-x), else its catalog name key, else its sku. */
export type PrizeServiceName = { label: string | null; sku: string | null; nameKey: string | null };

export type RewardInput = {
  tenantId: string;
  userId: string;
  source: RewardSource;
  referenceId: string;
  prize: RewardPrize;
  /** The admin who set the prize — the wheel version's or the lottery's creator; the change rows name them. */
  actorUserId: string;
  at: Date;
  /** The user's choice of Grant for GB or days; otherwise the issuer picks. */
  grantId?: string;
};

const DAY_MS = 86_400_000;
const CODE_PREFIX = 'WIN-';
const CODE_LENGTH = 10;
const LABEL = 'Prize';

const reasonOf = (input: RewardInput) => `engagement_reward ${input.source}:${input.referenceId}`;

type Candidate = { id: string; billingMode: VariantBillingMode; trafficUnlimited: boolean; startsAt: Date; endsAt: Date | null };

/** Can this Grant take this prize: a bag for GB, an end for days. The prize-service picker offers by the same rule (F-707-r). */
export function takes(grant: Pick<Candidate, 'trafficUnlimited' | 'endsAt'>, kind: SpinPrizeType): boolean {
  if (kind === SpinPrizeType.bonus_traffic_gb) return !grant.trafficUnlimited;
  return grant.endsAt !== null;
}

/** Runs longest first: no end, then the latest end; then the oldest, then the id — one answer for one state. */
function longestFirst(a: Candidate, b: Candidate): number {
  const end = (g: Candidate) => (g.endsAt === null ? Number.POSITIVE_INFINITY : g.endsAt.getTime());
  return end(b) - end(a) || a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id);
}

async function targetGrant(tx: Prisma.TransactionClient, input: RewardInput): Promise<Candidate> {
  const kind = input.prize.prizeType;
  const active = await tx.grant.findMany({
    where: { userId: input.userId, status: GrantStatus.active, ...(input.grantId ? { id: input.grantId } : {}) },
    select: { id: true, billingMode: true, trafficUnlimited: true, startsAt: true, endsAt: true },
  });
  if (input.grantId) {
    const named = active[0];
    if (!named || !takes(named, kind)) throw new RewardRefused('grant_not_eligible', input.grantId);
    return named;
  }
  const fit = active.filter((g) => takes(g, kind)).sort(longestFirst);
  if (fit.length === 0) throw new RewardRefused('no_active_grant', kind);
  // The user's choice, when it can take this prize; a gone or unfit one is automatic, never a refusal.
  const chosen = await tx.rewardTarget.findUnique({ where: { tenantId_userId: { tenantId: input.tenantId, userId: input.userId } }, select: { grantId: true } });
  return fit.find((g) => g.id === chosen?.grantId) ?? fit[0];
}

/** GB and days name their service; the other kinds give no service a user already holds. */
async function serviceOf(tx: Prisma.TransactionClient, kind: SpinPrizeType, grantId: string | null): Promise<PrizeServiceName | null> {
  if (!grantId || !(kind === SpinPrizeType.bonus_traffic_gb || kind === SpinPrizeType.extra_days)) return null;
  const g = await tx.grant.findUnique({ where: { id: grantId }, select: { userLabel: true, variant: { select: { sku: true, nameKey: true, product: { select: { nameKey: true } } } } } });
  return g ? { label: g.userLabel, sku: g.variant?.sku ?? null, nameKey: g.variant ? (g.variant.nameKey ?? g.variant.product.nameKey) : null } : null;
}

function couponCode(): string {
  let out = CODE_PREFIX;
  for (let i = 0; i < CODE_LENGTH; i++) out += GIFT_CODE_ALPHABET[randomInt(GIFT_CODE_ALPHABET.length)];
  return out;
}

/** The clone (ADR-0110), as a percent: never more than the template gives. */
async function issueCoupon(tx: Prisma.TransactionClient, input: RewardInput) {
  const { prize } = input;
  const template = await tx.coupon.findFirst({
    where: { id: prize.couponTemplateId as string, tenantId: input.tenantId, deletedAt: null },
    select: {
      tenantId: true,
      deletedAt: true,
      discountType: true,
      discountValue: true,
      maxDiscountCap: true,
      currencyCode: true,
      allowedChannels: true,
      gateways: { select: { gatewayId: true, tenantGatewayConfigId: true } },
      serviceScopes: { select: { productId: true, variantId: true } },
    },
  });
  if (!template || template.tenantId !== input.tenantId || template.deletedAt !== null) {
    throw new RewardRefused('coupon_template_unavailable', prize.couponTemplateId ?? undefined);
  }
  let percent: Prisma.Decimal;
  let cap: Prisma.Decimal | null;
  if (template.discountType === DiscountType.percentage) {
    percent = Prisma.Decimal.min(template.discountValue, prize.prizeValue);
    cap = template.maxDiscountCap;
  } else if (template.discountType === DiscountType.fixed_amount) {
    percent = prize.prizeValue;
    cap = template.discountValue;
  } else {
    throw new RewardRefused('coupon_template_unavailable', template.discountType);
  }

  const expiresAt = new Date(input.at.getTime() + (prize.couponValidDays as number) * DAY_MS);
  const coupon = await tx.coupon.create({
    data: {
      tenantId: input.tenantId,
      code: couponCode(),
      discountType: DiscountType.percentage,
      discountValue: percentText(percent),
      maxDiscountCap: cap ? moneyText(cap) : null,
      currencyCode: template.currencyCode,
      totalUsageLimit: 1,
      perUserUsageLimit: 1,
      expiresAt,
      isActive: true,
      visibility: CouponVisibility.targeted,
      allowedChannels: template.allowedChannels as CouponChannel[],
      createdByAdminId: input.actorUserId,
      label: LABEL,
      allowedUsers: { create: [{ userId: input.userId }] },
      serviceScopes: { create: template.serviceScopes.map((s) => ({ productId: s.productId, variantId: s.variantId })) },
      gateways: { create: template.gateways.map((g) => ({ gatewayId: g.gatewayId, tenantGatewayConfigId: g.tenantGatewayConfigId })) },
    },
    select: { id: true, code: true, expiresAt: true },
  });
  return { id: coupon.id, code: coupon.code, percent: percentText(percent), expiresAt };
}

export async function issueReward(tx: Prisma.TransactionClient, grants: GrantService, input: RewardInput): Promise<RewardIssued> {
  const { prize } = input;
  if (prize.prizeType === SpinPrizeType.wallet_credit) throw new RewardRefused('no_cash');
  if (prize.prizeType === SpinPrizeType.empty) throw new RangeError('an empty slot gives nothing to issue');

  const prior = await tx.rewardIssue.findUnique({
    where: { source_referenceId: { source: input.source, referenceId: input.referenceId } },
    select: { id: true, userId: true, prizeType: true, grantId: true, couponId: true },
  });
  if (prior) {
    if (prior.userId !== input.userId || prior.prizeType !== prize.prizeType) throw new RewardRefused('reference_reused', input.referenceId);
    const coupon = prior.couponId
      ? await tx.coupon.findFirst({ where: { id: prior.couponId }, select: { id: true, code: true, discountValue: true, expiresAt: true } })
      : null;
    return {
      rewardId: prior.id,
      prizeType: prior.prizeType,
      replay: true,
      grantId: prior.grantId,
      service: await serviceOf(tx, prior.prizeType, prior.grantId),
      coupon: coupon ? { id: coupon.id, code: coupon.code, percent: percentText(new Prisma.Decimal(coupon.discountValue)), expiresAt: coupon.expiresAt as Date } : null,
    };
  }

  const record: { grantId?: string; quotaAdjustmentId?: string; durationChangeId?: string; couponId?: string } = {};
  let coupon: RewardIssued['coupon'] = null;
  switch (prize.prizeType) {
    case SpinPrizeType.bonus_traffic_gb: {
      const grant = await targetGrant(tx, input);
      const bytes = bytesOfGb(prize.prizeValue.toNumber());
      const reason = reasonOf(input);
      const change =
        grant.billingMode === VariantBillingMode.metered
          ? await giftGrantBytes(tx, grant.id, { at: input.at, actorUserId: input.actorUserId, bytes, reason, giver: 'reseller', source: GrantSource.engagement_reward })
          : await adjustGrantTraffic(tx, grant.id, { at: input.at, actorUserId: input.actorUserId, deltaBytes: bytes, reason, source: GrantSource.engagement_reward });
      Object.assign(record, { grantId: grant.id, quotaAdjustmentId: change.adjustmentId });
      break;
    }
    case SpinPrizeType.extra_days: {
      const grant = await targetGrant(tx, input);
      const change = await changeGrantDuration(tx, grant.id, {
        at: input.at,
        actorUserId: input.actorUserId,
        change: { days: prize.prizeValue.toNumber() },
        reason: reasonOf(input),
      });
      Object.assign(record, { grantId: grant.id, durationChangeId: change.changeId });
      break;
    }
    case SpinPrizeType.discount_coupon: {
      coupon = await issueCoupon(tx, input);
      record.couponId = coupon.id;
      break;
    }
    case SpinPrizeType.free_grant: {
      const tenant = await tx.tenant.findUnique({ where: { id: input.tenantId }, select: { tenantType: true } });
      const issued = await issueGrantByAdmin(tx, grants, {
        userId: input.userId,
        variantId: prize.variantId as string,
        requestId: input.referenceId,
        actorUserId: input.actorUserId,
        at: input.at,
        // The reseller hands it out itself: its own limits apply, as to its staff.
        bounded: tenant?.tenantType === 'reseller',
        source: GrantSource.engagement_reward,
      });
      record.grantId = issued.grantId;
      break;
    }
  }

  const row = await tx.rewardIssue.create({
    data: { tenantId: input.tenantId, source: input.source, referenceId: input.referenceId, userId: input.userId, prizeType: prize.prizeType, ...record },
    select: { id: true },
  });
  return { rewardId: row.id, prizeType: prize.prizeType, replay: false, grantId: record.grantId ?? null, service: await serviceOf(tx, prize.prizeType, record.grantId ?? null), coupon };
}
