import { CouponChannel, CouponVisibility, DiscountType, RedemptionStatus } from '@prisma/client';
import { GATEWAY_CREDENTIAL_SOURCES } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { COUPON_KINDS, COUPON_LIST_STATUSES } from './coupon-admin.service';
import { GIFT_BATCH_MAX } from './coupon-batch.service';

/**
 * The wire shapes of coupon management (F-502-f).
 *
 * **`.strict()` on every body.** An unknown key is refused, not dropped: a
 * client sending `usedCount`, `tenantId` on an update or `deletedAt` expects it
 * to land, and silently ignoring it is a coupon the admin believes is set up
 * some way it is not.
 *
 * The schema bounds shapes; the rules (who, frozen fields, limit pairs) are
 * `CouponAdminService`'s, which answers each with its own reason.
 * Decimals are strings (C-02); enums come from Prisma (C-09).
 */

const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const decimal = (what: string) => z.string({ message: `${what} must be a decimal string` }).regex(DECIMAL, { message: `${what} must be a decimal string` });
const uuid = (what: string) => z.string({ message: `${what} must be a uuid` }).uuid({ message: `${what} must be a uuid` });
const instant = (what: string) => z.string().datetime({ offset: true, message: `${what} must be an ISO instant` });
const count = z.number().int().min(0).max(1_000_000);

const fields = {
  code: z.string().trim().min(3).max(40),
  discountType: z.nativeEnum(DiscountType),
  discountValue: decimal('discountValue'),
  maxDiscountCap: decimal('maxDiscountCap').nullable(),
  minPurchaseAmount: decimal('minPurchaseAmount').nullable(),
  maxPurchaseAmount: decimal('maxPurchaseAmount').nullable(),
  totalUsageLimit: count.nullable(),
  perUserUsageLimit: count,
  expiresAt: instant('expiresAt').nullable(),
  validFrom: instant('validFrom').nullable(),
  isActive: z.boolean(),
  visibility: z.nativeEnum(CouponVisibility),
  activeWeekdays: z.array(z.number().int()).max(7),
  activeHourFrom: z.number().int().nullable(),
  activeHourTo: z.number().int().nullable(),
  firstPurchaseOnly: z.boolean(),
  newUserWithinDays: z.number().int().max(36_500).nullable(),
  periodUsageLimit: count.nullable(),
  periodDays: z.number().int().max(36_500).nullable(),
  allowedChannels: z.array(z.nativeEnum(CouponChannel)).max(2),
  label: z.string().trim().max(100).nullable(),
  note: z.string().trim().max(1000).nullable(),
  allowedUserIds: z.array(uuid('allowedUserIds')).max(1000),
  tenantIds: z.array(uuid('tenantIds')).max(1000),
  gateways: z.array(z.object({ source: z.enum(GATEWAY_CREDENTIAL_SOURCES), id: uuid('gateway id') }).strict()).max(50),
  serviceScopes: z
    .array(z.object({ productId: uuid('productId').nullable().optional(), variantId: uuid('variantId').nullable().optional() }).strict())
    .max(100),
  /** A `free_grant` coupon's variant (F-502-l-a). */
  grantVariantId: uuid('grantVariantId').nullable(),
};

const optional = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]>;
};

export const createCouponSchema = z
  .object({
    ...optional,
    code: fields.code,
    discountType: fields.discountType,
    discountValue: fields.discountValue,
    /** Absent = the caller's tenant; `null` = a platform coupon; another = the platform owner's alone. */
    tenantId: uuid('tenantId').nullable().optional(),
  })
  .strict();

export const updateCouponSchema = z.object(optional).strict();

const page = {
  page: z.coerce.number().int().min(1).max(100_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
};

export const listCouponsSchema = z.object({
  tenantId: z.union([z.literal('platform'), uuid('tenantId')]).optional(),
  status: z.enum(COUPON_LIST_STATUSES).optional(),
  kind: z.enum(COUPON_KINDS).optional(),
  q: z.string().trim().max(40).optional(),
  batchId: uuid('batchId').optional(),
  ...page,
});

export const generateBatchSchema = z
  .object({
    tenantId: uuid('tenantId').nullable().optional(),
    label: z.string().trim().min(1).max(100),
    note: z.string().trim().max(1000).nullable().optional(),
    count: z.number().int().min(1).max(GIFT_BATCH_MAX),
    value: decimal('value'),
    /** Set: a free-service batch of this variant, and `value` is 0 (F-502-l-a). */
    grantVariantId: uuid('grantVariantId').nullable().optional(),
    prefix: z.string().trim().max(8).nullable().optional(),
    expiresAt: instant('expiresAt').nullable().optional(),
    tenantIds: z.array(uuid('tenantIds')).max(1000).optional(),
  })
  .strict();

export const listBatchesSchema = z.object({ tenantId: z.union([z.literal('platform'), uuid('tenantId')]).optional(), ...page });

export const usageSchema = z.object({
  status: z.nativeEnum(RedemptionStatus).optional(),
  from: instant('from').optional(),
  to: instant('to').optional(),
  ...page,
});

export type CreateCouponBody = z.infer<typeof createCouponSchema>;
export type UpdateCouponBody = z.infer<typeof updateCouponSchema>;
export type ListCouponsQuery = z.infer<typeof listCouponsSchema>;
export type GenerateBatchBody = z.infer<typeof generateBatchSchema>;
export type ListBatchesQuery = z.infer<typeof listBatchesSchema>;
export type UsageQuery = z.infer<typeof usageSchema>;
