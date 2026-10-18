import { randomInt } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { CouponChannel, CouponVisibility, DiscountType, Prisma } from '@prisma/client';
import { currencyPlacesOf, quotaPeriodAt, resolveTimeZone, roundCredit, runWithTenant, tenantTransaction, moneyText, percentText, MONEY_PATTERN } from '@txnet-backend/shared-core';
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

/** A percentage, 0..100 at two places, as the AI engine sends it. */
const percent = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/);

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
    maxDiscountPercent: percent,
    dailyBudget: z.string().regex(MONEY_PATTERN),
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

/**
 * The cloned coupon's discount on `price` and what it charges the budget —
 * never more than either the offer's cap or the template's own, rounded down
 * to the price currency's `places` (ADR-0153). Null for a template that is no
 * discount, or a discount of nothing.
 */
export function personalCouponTerms(
  { amount: price, places }: { amount: Prisma.Decimal; places: number },
  maxPercent: Prisma.Decimal,
  template: TemplateTerms | null,
): PersonalTerms | null {
  const down = (d: Prisma.Decimal) => roundCredit(d, places);
  const capped = down(price.times(maxPercent).dividedBy(100));
  let terms: PersonalTerms;
  if (!template) {
    terms = { discountType: DiscountType.percentage, discountValue: percentText(maxPercent), maxDiscountCap: null, charge: moneyText(capped) };
  } else if (template.discountType === DiscountType.percentage) {
    const percent = Prisma.Decimal.min(template.discountValue, maxPercent);
    let charge = down(price.times(percent).dividedBy(100));
    if (template.maxDiscountCap !== null) charge = Prisma.Decimal.min(charge, template.maxDiscountCap);
    terms = { discountType: DiscountType.percentage, discountValue: percentText(percent), maxDiscountCap: template.maxDiscountCap ? moneyText(template.maxDiscountCap) : null, charge: moneyText(charge) };
  } else if (template.discountType === DiscountType.fixed_amount) {
    const value = Prisma.Decimal.min(template.discountValue, capped);
    terms = { discountType: DiscountType.fixed_amount, discountValue: moneyText(value), maxDiscountCap: null, charge: moneyText(value) };
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
        const after = (discount: Prisma.Decimal): Money => ({ amount: moneyText(Prisma.Decimal.max(price.minus(discount), 0)), currencyCode });

        const existing = await tx.coupon.findFirst({
          where: { aiActionId: body.actionId },
          select: { code: true, aiBudgetCharge: true, currencyCode: true, expiresAt: true },
        });
        if (existing?.aiBudgetCharge) {
          return {
            issued: {
              code: existing.code,
              discount: { amount: moneyText(existing.aiBudgetCharge), currencyCode: existing.currencyCode },
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
        const places = await currencyPlacesOf(tx, currencyCode);
        const terms = personalCouponTerms({ amount: price, places }, new Prisma.Decimal(body.maxDiscountPercent), template);
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
