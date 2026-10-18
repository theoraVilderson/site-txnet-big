import { SpinPrizeType } from '@prisma/client';
import { MONEY_PATTERN } from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * The wire shape of a wheel version (F-707-c).
 *
 * `.strict()`, as every admin body here: an unknown key is refused, not
 * dropped. The schema bounds shapes; the rules — what each kind of prize
 * carries, no cash, the expected cost against the cap, whose template,
 * variant and group — are `WheelAdminService`'s, each with its own reason.
 * Decimals are strings (C-02); the kind comes from Prisma (C-09).
 */

const decimal = (what: string) => z.string({ message: `${what} must be a decimal string` }).regex(MONEY_PATTERN, { message: `${what} must be a decimal string` });
const uuid = (what: string) => z.string({ message: `${what} must be a uuid` }).uuid({ message: `${what} must be a uuid` });

const prizeSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    prizeType: z.nativeEnum(SpinPrizeType),
    prizeValue: decimal('prizeValue'),
    couponTemplateId: uuid('couponTemplateId').nullable().optional(),
    couponValidDays: z.number().int().min(1).max(365).nullable().optional(),
    variantId: uuid('variantId').nullable().optional(),
    weight: z.number().int().min(1).max(1_000_000),
    costAmount: decimal('costAmount'),
    dailyStockLimit: z.number().int().min(0).max(1_000_000).nullable().optional(),
  })
  .strict();

export const wheelVersionSchema = z
  .object({
    isActive: z.boolean().optional(),
    dailyBudgetCapAmount: decimal('dailyBudgetCapAmount'),
    perUserCooldownHours: z.number().int().min(0).max(24 * 30).optional(),
    maxSpinsPerAccountPerDay: z.number().int().min(1).max(24).optional(),
    requiresMinAccountAgeHours: z.number().int().min(0).max(24 * 365).optional(),
    requiresMinTotalPurchaseAmount: decimal('requiresMinTotalPurchaseAmount').nullable().optional(),
    requiresMinCompletedOrdersCount: z.number().int().min(0).max(10_000).nullable().optional(),
    requiresActiveServiceAtSpinTime: z.boolean().optional(),
    requiresPhoneVerified: z.boolean().optional(),
    userGroupId: uuid('userGroupId').nullable().optional(),
    // A wheel the client can draw: two slots at least, a dozen and a half at most.
    prizes: z.array(prizeSchema).min(2).max(16),
  })
  .strict();

export type WheelVersionBody = z.infer<typeof wheelVersionSchema>;
