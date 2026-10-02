import { Injectable } from '@nestjs/common';
import { Prisma, type AiActionType, type AiOffer } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { AiReaderPrisma, PrismaService } from '../prisma/prisma.service';

/**
 * F-038-f1 (ADR-0110, ADR-0109 point 9): the offers a tenant defines — the only
 * discounts the engine may ever give. Each targets exactly one thing:
 *
 * - **a coupon template** — one of the tenant's own discount coupons
 *   (`percentage` or `fixed_amount`, not deleted; it may be inactive, so
 *   nobody types its code). At delivery billing clones it into a personal
 *   coupon (F-038-f3). A platform coupon is not the tenant's to lend: its users
 *   could not redeem the clone (ADR-0099); a gift code or a free service is not
 *   a discount;
 * - **a variant** the tenant still sells (active, visible under its RLS).
 *
 * What an offer targets and the type it rides on are fixed at creation: the
 * actions that cite it would otherwise change meaning. Name, discount cap,
 * budget and on/off are edited; switching it off stops every suggestion still
 * queued with it, as the type switch does (F-1509). There is no delete — the
 * audit keeps the offer its actions name.
 */

/** The action types an offer can ride on (ADR-0110 point 3). A later type with a discount adds itself here. */
export const OFFER_ACTION_TYPES = ['retain_offer'] as const satisfies readonly AiActionType[];

/** The coupon types that are a discount on a purchase; a gift code and a free service are not. */
const DISCOUNT_TYPES: readonly string[] = ['percentage', 'fixed_amount'];

export type OfferRefusal = 'template_not_found' | 'template_not_a_discount' | 'variant_not_found' | 'offer_not_found';

export class OfferRefused extends Error {
  constructor(readonly reason: OfferRefusal) {
    super(reason);
  }
}

// C-02: money and the percentage arrive as decimal strings, never a float.
const percent = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/)
  .refine((v) => Number(v) > 0 && new Prisma.Decimal(v).lte(100), 'between 0 (exclusive) and 100');
const amount = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/);
const currency = z.string().regex(/^[A-Z]{3}$/);

export const offerBodySchema = z
  .object({
    tenantId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    actionType: z.enum(OFFER_ACTION_TYPES),
    couponTemplateId: z.string().uuid().optional(),
    variantId: z.string().uuid().optional(),
    maxDiscountPercent: percent,
    dailyBudget: amount,
    currencyCode: currency,
    createdByUserId: z.string().uuid(),
  })
  .strict()
  .refine((b) => (b.couponTemplateId === undefined) !== (b.variantId === undefined), 'exactly one of couponTemplateId, variantId');

export const offerPatchSchema = z
  .object({
    tenantId: z.string().uuid(),
    name: z.string().trim().min(1).max(120).optional(),
    maxDiscountPercent: percent.optional(),
    dailyBudget: amount.optional(),
    currencyCode: currency.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type OfferBody = z.infer<typeof offerBodySchema>;
export type OfferPatch = z.infer<typeof offerPatchSchema>;

export type OfferView = {
  id: string;
  name: string;
  actionType: AiActionType;
  target: { couponTemplateId: string | null; variantId: string | null };
  maxDiscountPercent: string;
  dailyBudget: string;
  currencyCode: string;
  isActive: boolean;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export function offerView(o: AiOffer): OfferView {
  return {
    id: o.id,
    name: o.name,
    actionType: o.actionType,
    target: { couponTemplateId: o.couponTemplateId, variantId: o.variantId },
    maxDiscountPercent: o.maxDiscountPercent.toFixed(2),
    dailyBudget: o.dailyBudget.toFixed(2),
    currencyCode: o.currencyCode,
    isActive: o.isActive,
    createdByUserId: o.createdByUserId,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

@Injectable()
export class Offers {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: AiReaderPrisma,
  ) {}

  async create(body: OfferBody): Promise<OfferView> {
    const { tenantId } = body;
    await this.checkTarget(tenantId, body.couponTemplateId ?? null, body.variantId ?? null);
    const created = await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, (tx) =>
        tx.aiOffer.create({
          data: {
            tenantId,
            name: body.name,
            actionType: body.actionType,
            couponTemplateId: body.couponTemplateId ?? null,
            variantId: body.variantId ?? null,
            maxDiscountPercent: body.maxDiscountPercent,
            dailyBudget: body.dailyBudget,
            currencyCode: body.currencyCode,
            createdByUserId: body.createdByUserId,
          },
        }),
      ),
    );
    return offerView(created);
  }

  async update(offerId: string, patch: OfferPatch): Promise<OfferView> {
    const { tenantId, ...data } = patch;
    const updated = await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const found = await tx.aiOffer.findFirst({ where: { id: offerId, tenantId }, select: { id: true } });
        if (!found) throw new OfferRefused('offer_not_found');
        const row = await tx.aiOffer.update({ where: { id: offerId }, data });
        if (data.isActive === false) {
          await tx.aiAction.updateMany({
            where: { tenantId, offerId, status: { in: ['scheduled', 'awaiting_approval'] } },
            data: { status: 'suppressed', suppressedBy: 'offer_guardrail' },
          });
        }
        return row;
      }),
    );
    return offerView(updated);
  }

  async list(tenantId: string): Promise<OfferView[]> {
    const rows = await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, (tx) => tx.aiOffer.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } })),
    );
    return rows.map(offerView);
  }

  /** The target, read through the reader role under the tenant's RLS (invariant 7). */
  private async checkTarget(tenantId: string, couponTemplateId: string | null, variantId: string | null): Promise<void> {
    const refusal = await runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.reader, async (tx): Promise<OfferRefusal | null> => {
        if (couponTemplateId) {
          const coupon = await tx.coupon.findFirst({ where: { id: couponTemplateId }, select: { id: true, tenantId: true, discountType: true, deletedAt: true } });
          if (!coupon || coupon.tenantId !== tenantId || coupon.deletedAt) return 'template_not_found';
          return DISCOUNT_TYPES.includes(coupon.discountType) ? null : 'template_not_a_discount';
        }
        const variant = await tx.productVariant.findFirst({ where: { id: variantId ?? undefined }, select: { id: true, isActive: true } });
        return variant?.isActive ? null : 'variant_not_found';
      }),
    );
    if (refusal) throw new OfferRefused(refusal);
  }
}
