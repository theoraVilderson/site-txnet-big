import { TenantLedgerDirection } from '@prisma/client';
import { MONEY_PATTERN } from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * The wire shape of a manual billing-wallet adjustment (F-019-a).
 *
 * `.strict()`: an unknown key is refused, not dropped. The amount is a decimal
 * string (C-02); the direction comes from the Prisma enum (C-09).
 */


export const adjustSchema = z
  .object({
    direction: z.nativeEnum(TenantLedgerDirection),
    amount: z.string().regex(MONEY_PATTERN, { message: 'amount must be a decimal string' }),
    requestId: z.string().uuid({ message: 'requestId must be a uuid' }),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type AdjustBody = z.infer<typeof adjustSchema>;
