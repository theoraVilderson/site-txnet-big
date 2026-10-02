import { randomInt } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { CouponChannel, CouponVisibility, DiscountType, Prisma } from '@prisma/client';
import { quotaPeriodAt, resolveTimeZone, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { sellableOfferById } from '../../catalog/catalog-reads';
import { PrismaService } from '../../prisma/prisma.service';
import { GIFT_CODE_ALPHABET } from '../coupon-admin/coupon-batch.service';

/**
 * F-038-f3 (ADR-0110 points 1, 2): the personal coupon an AI `retain_offer`
 * suggestion carries, issued by billing when the suggestion is delivered —
 * the engine writes no billing table (ai invariant 7), and asks here through
 * the worker (F-038-g3).
 *
 * **Cloned, narrowed.** From the offer's template, its gateways and channels;
 * the discount the lower of the template's own and the offer's cap
 * ({@link personalCouponTerms}). Then narrowed to what the suggestion is
 * about: `targeted` at the one user, the one plan, one use, expiring at the
 * suggestion's deadline. A variant offer has no template: the offer's
 * percentage on that plan. The template's other limits (window, minimum,
 * first purchase) are not copied — this coupon is already for one renewal of
 * one plan by one user.
 *
 * **The budget is spent at issue**, in the tenant's own day: the sum of
 * today's issued charges plus this one may not pass `dailyBudget`, under a
 * per-offer transaction lock so two deliveries at once cannot both fit the
 * last slot. An unused coupon is not given back (ADR-0110 point 2).
 *
 * **Once per suggestion.** `aiActionId` is unique: a retried delivery answers
 * the coupon already issued and charges nothing again.
 */

const CODE_PREFIX = 'AI-';
const CODE_LENGTH = 10;
/** What the panel and the AI page call it; never shown to the user (D-33). */
const LABEL = 'AI offer';

const amount = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/);

export const aiOfferCouponSchema = z
  .object({
    tenantId: z.string().uuid(),
    userId: z.string().uuid(),
    actionId: z.string().uuid(),
    offerId: z.string().uuid(),
    /** The admin who made the offer: the coupon's `createdByAdminId`. */
    createdByUserId: z.string().uuid(),
    /** The plan the suggestion names — the coupon's only scope. */
    variantId: z.string().uuid(),
    couponTemplateId: z.string().uuid().nullable(),
    maxDiscountPercent: amount,
    dailyBudget: amount,
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type AiOfferCouponBody = z.infer<typeof aiOfferCouponSchema>;

type Money = { amount: string; currencyCode: string };
export type AiOfferCouponAnswer =
  | { issued: { code: string; discount: Money; priceAfter: Money; expiresAt: string } }
  | { refused: 'plan_unavailable' | 'offer_unavailable' }
  | { refused: 'budget_spent'; retryAt: string };

type TemplateTerms = { discountType: string; discountValue: Prisma.Decimal; maxDiscountCap: Prisma.Decimal | null };
export type PersonalTerms = { discountType: DiscountType; discountValue: string; maxDiscountCap: string | null; charge: string };

const down = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);

/**
 * The cloned coupon's discount on `price` and what it charges the budget —
 * never more than either the offer's cap or the template's own. Null for a
 * template that is no discount, or a discount of nothing.
 */
export function personalCouponTerms(price: Prisma.Decimal, maxPercent: Prisma.Decimal, template: TemplateTerms | null): PersonalTerms | null {
  const capped = down(price.times(maxPercent).dividedBy(100));
  let terms: PersonalTerms;
  if (!template) {
    terms = { discountType: DiscountType.percentage, discountValue: maxPercent.toFixed(2), maxDiscountCap: null, charge: capped.toFixed(2) };
  } else if (template.discountType === DiscountType.percentage) {
    const percent = Prisma.Decimal.min(template.discountValue, maxPercent);
    let charge = down(price.times(percent).dividedBy(100));
    if (template.maxDiscountCap !== null) charge = Prisma.Decimal.min(charge, template.maxDiscountCap);
    terms = { discountType: DiscountType.percentage, discountValue: percent.toFixed(2), maxDiscountCap: template.maxDiscountCap?.toFixed(2) ?? null, charge: charge.toFixed(2) };
  } else if (template.discountType === DiscountType.fixed_amount) {
    const value = Prisma.Decimal.min(template.discountValue, capped);
    terms = { discountType: DiscountType.fixed_amount, discountValue: value.toFixed(2), maxDiscountCap: null, charge: value.toFixed(2) };
  } else {
    return null;
  }
  return new Prisma.Decimal(terms.charge).gt(0) ? terms : null;
}

function newCode(): string {
  let out = CODE_PREFIX;
  for (let i = 0; i < CODE_LENGTH; i++) out += GIFT_CODE_ALPHABET[randomInt(GIFT_CODE_ALPHABET.length)];
  return out;
}

/** The tenant's own template, not deleted — an inactive one still lends its terms (F-038-f1). */
function readTemplate(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  return tx.coupon.findFirst({
    where: { id, tenantId, deletedAt: null },
    select: {
      discountType: true,
      discountValue: true,
      maxDiscountCap: true,
      currencyCode: true,
      allowedChannels: true,
      gateways: { select: { gatewayId: true, tenantGatewayConfigId: true } },
      serviceScopes: { select: { productId: true, variantId: true } },
    },
  });
}

@Injectable()
export class AiOfferCouponService {
  constructor(private readonly prisma: PrismaService) {}

  issue(body: AiOfferCouponBody, now: Date = new Date(), offerOf: typeof sellableOfferById = sellableOfferById): Promise<AiOfferCouponAnswer> {
    const { tenantId } = body;
    return runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, async (tx): Promise<AiOfferCouponAnswer> => {
        // The price billing would sell the plan at now — never the engine's.
        const plan = await offerOf(tx, body.variantId, now);
        if (!plan) return { refused: 'plan_unavailable' };
        const price = new Prisma.Decimal(plan.price.amount);
        const currencyCode = plan.price.currencyCode;
        const after = (discount: Prisma.Decimal): Money => ({ amount: Prisma.Decimal.max(price.minus(discount), 0).toFixed(2), currencyCode });

        const existing = await tx.coupon.findFirst({
          where: { aiActionId: body.actionId },
          select: { code: true, aiBudgetCharge: true, currencyCode: true, expiresAt: true },
        });
        if (existing?.aiBudgetCharge) {
          return {
            issued: {
              code: existing.code,
              discount: { amount: existing.aiBudgetCharge.toFixed(2), currencyCode: existing.currencyCode },
              priceAfter: after(existing.aiBudgetCharge),
              expiresAt: (existing.expiresAt ?? new Date(body.expiresAt)).toISOString(),
            },
          };
        }
        // The engine converts nothing, and neither does an offer's budget.
        if (currencyCode !== body.currencyCode) return { refused: 'offer_unavailable' };

        let template: Awaited<ReturnType<typeof readTemplate>> = null;
        if (body.couponTemplateId) {
          template = await readTemplate(tx, tenantId, body.couponTemplateId);
          if (!template || template.currencyCode !== currencyCode) return { refused: 'offer_unavailable' };
          const scoped = template.serviceScopes.length === 0 || template.serviceScopes.some((s) => s.variantId === plan.variantId || s.productId === plan.productId);
          if (!scoped) return { refused: 'offer_unavailable' };
        }
        const terms = personalCouponTerms(price, new Prisma.Decimal(body.maxDiscountPercent), template);
        if (!terms) return { refused: 'offer_unavailable' };

        // One offer's budget at a time: the sum and the insert are one decision.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-offer:${body.offerId}`}))`;
        const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
        const day = quotaPeriodAt('day', now, resolveTimeZone({ tenant }).zone);
        const spent = await tx.coupon.aggregate({
          where: { tenantId, aiOfferId: body.offerId, createdAt: { gte: day.start } },
          _sum: { aiBudgetCharge: true },
        });
        const charge = new Prisma.Decimal(terms.charge);
        if ((spent._sum.aiBudgetCharge ?? new Prisma.Decimal(0)).plus(charge).gt(body.dailyBudget)) {
          return { refused: 'budget_spent', retryAt: day.end.toISOString() };
        }

        const coupon = await tx.coupon.create({
          data: {
            tenantId,
            code: newCode(),
            discountType: terms.discountType,
            discountValue: terms.discountValue,
            maxDiscountCap: terms.maxDiscountCap,
            currencyCode,
            totalUsageLimit: 1,
            perUserUsageLimit: 1,
            expiresAt: new Date(body.expiresAt),
            isActive: true,
            visibility: CouponVisibility.targeted,
            allowedChannels: (template?.allowedChannels ?? []) as CouponChannel[],
            createdByAdminId: body.createdByUserId,
            label: LABEL,
            aiActionId: body.actionId,
            aiOfferId: body.offerId,
            aiBudgetCharge: terms.charge,
            allowedUsers: { create: [{ userId: body.userId }] },
            serviceScopes: { create: [{ variantId: plan.variantId }] },
            gateways: { create: (template?.gateways ?? []).map((g) => ({ gatewayId: g.gatewayId, tenantGatewayConfigId: g.tenantGatewayConfigId })) },
          },
          select: { code: true },
        });
        return { issued: { code: coupon.code, discount: { amount: terms.charge, currencyCode }, priceAfter: after(charge), expiresAt: new Date(body.expiresAt).toISOString() } };
      }),
    );
  }
}
