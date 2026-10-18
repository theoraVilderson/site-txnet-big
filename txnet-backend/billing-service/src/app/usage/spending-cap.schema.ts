import { SpendingCapPeriod } from '@prisma/client';
import { BackendI18nKeys, MONEY_PATTERN } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { MAX_CAP_LABEL_LENGTH } from './spending-cap';

const E = BackendI18nKeys.errors.billing;

/** A positive amount in the wallet's currency; its places are checked by the service (F-116-r, C-02). */

/**
 * The body of `PUT /api/billing/traffic/grants/:grantId/cap` (F-118-i): who
 * the Grant is for, the cap in the wallet's currency — a decimal string, never
 * a float — and its period. The currency is the wallet's, never a field.
 */
export const spendingCapSchema = z.object({
  label: z.string({ message: E.spendingCapInvalid }).trim().min(1, { message: E.spendingCapInvalid }).max(MAX_CAP_LABEL_LENGTH, { message: E.spendingCapInvalid }),
  amount: z
    .string({ message: E.spendingCapInvalid })
    .regex(MONEY_PATTERN, { message: E.spendingCapInvalid })
    .refine((v) => Number(v) > 0, { message: E.spendingCapInvalid }),
  period: z.nativeEnum(SpendingCapPeriod, { message: E.spendingCapInvalid }),
});

export type SpendingCapBody = z.infer<typeof spendingCapSchema>;
