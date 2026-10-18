import { LotteryEntryMode, SpinPrizeType } from '@prisma/client';
import { MONEY_PATTERN } from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * The wire shape of a lottery draft (F-707-i).
 *
 * `.strict()`, as every admin body here. The schema bounds shapes; the rules —
 * what each kind of prize carries, no cash, no empty prize, the close time,
 * whose group, template and variant — are `LotteryAdminService`'s, each with
 * its own reason. Decimals are strings (C-02); enums come from Prisma (C-09).
 */

const decimal = (what: string) => z.string({ message: `${what} must be a decimal string` }).regex(MONEY_PATTERN, { message: `${what} must be a decimal string` });
const uuid = (what: string) => z.string({ message: `${what} must be a uuid` }).uuid({ message: `${what} must be a uuid` });

const prizeSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    prizeType: z.nativeEnum(SpinPrizeType),
    prizeValue: decimal('prizeValue'),
    couponTemplateId: uuid('couponTemplateId').nullable().optional(),
    couponValidDays: z.number().int().min(1).max(365).nullable().optional(),
    variantId: uuid('variantId').nullable().optional(),
    winnersCount: z.number().int().min(1).max(1000),
  })
  .strict();

export const lotteryDraftSchema = z
  .object({
    userGroupId: uuid('userGroupId'),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullable().optional(),
    entryMode: z.nativeEnum(LotteryEntryMode),
    closesAt: z.string().datetime({ offset: true, message: 'closesAt must be an ISO 8601 instant' }),
    requiresPhoneVerified: z.boolean().optional(),
    requiresMinAccountAgeHours: z.number().int().min(0).max(24 * 365).optional(),
    reservesCount: z.number().int().min(0).max(100).optional(),
    // In rank order: the first is rank 1.
    prizes: z.array(prizeSchema).min(1).max(20),
  })
  .strict();

export type LotteryDraftBody = z.infer<typeof lotteryDraftSchema>;

/** The reason is public: users are told why their lottery stopped (ADR-0111 point 5). */
export const lotteryCancelSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

export type LotteryCancelBody = z.infer<typeof lotteryCancelSchema>;
