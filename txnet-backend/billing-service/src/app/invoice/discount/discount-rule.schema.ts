import { DiscountRuleKind } from '@prisma/client';
import { z } from 'zod';

/**
 * The wire shapes of discount-rule management (F-114-h).
 *
 * `.strict()` on every body, as coupon management's: an unknown key is
 * refused, not dropped — an admin sending `tenantId` expects it to land. The
 * schema bounds shapes; the rules (value range, one target, a window that
 * ends after it starts, whose users) are `DiscountRuleAdminService`'s, each
 * answered with its own reason. Decimals are strings (C-02); the kind comes
 * from Prisma (C-09).
 */

const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const uuid = (what: string) => z.string({ message: `${what} must be a uuid` }).uuid({ message: `${what} must be a uuid` });
const instant = (what: string) => z.string().datetime({ offset: true, message: `${what} must be an ISO instant` });

const fields = {
  name: z.string().trim().min(1).max(80),
  kind: z.nativeEnum(DiscountRuleKind),
  value: z.string({ message: 'value must be a decimal string' }).regex(DECIMAL, { message: 'value must be a decimal string' }),
  productId: uuid('productId').nullable(),
  categoryId: uuid('categoryId').nullable(),
  forNamedUsers: z.boolean(),
  userIds: z.array(uuid('userIds')).max(1000),
  startsAt: instant('startsAt'),
  endsAt: instant('endsAt').nullable(),
  isActive: z.boolean(),
};

export const createDiscountRuleSchema = z
  .object({
    ...fields,
    productId: fields.productId.optional(),
    categoryId: fields.categoryId.optional(),
    forNamedUsers: fields.forNamedUsers.optional(),
    userIds: fields.userIds.optional(),
    endsAt: fields.endsAt.optional(),
    isActive: fields.isActive.optional(),
  })
  .strict();

export const updateDiscountRuleSchema = z
  .object(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]> })
  .strict();

export type CreateDiscountRuleBody = z.infer<typeof createDiscountRuleSchema>;
export type UpdateDiscountRuleBody = z.infer<typeof updateDiscountRuleSchema>;
