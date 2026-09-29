import { SpendingCapPeriod } from '@prisma/client';
import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { MAX_CAP_LABEL_LENGTH } from './spending-cap';

const E = BackendI18nKeys.errors.billing;

/** A positive amount in whole minor units: at most two decimals, as `Decimal(18, 2)` holds it (C-02). */
const AMOUNT = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;

/**
 * The body of `PUT /api/billing/traffic/grants/:grantId/cap` (F-118-i): who
 * the Grant is for, the cap in the wallet's currency — a decimal string, never
 * a float — and its period. The currency is the wallet's, never a field.
 */
export const spendingCapSchema = z.object({
  label: z.string({ message: E.spendingCapInvalid }).trim().min(1, { message: E.spendingCapInvalid }).max(MAX_CAP_LABEL_LENGTH, { message: E.spendingCapInvalid }),
  amount: z
    .string({ message: E.spendingCapInvalid })
    .regex(AMOUNT, { message: E.spendingCapInvalid })
    .refine((v) => Number(v) > 0, { message: E.spendingCapInvalid }),
  period: z.nativeEnum(SpendingCapPeriod, { message: E.spendingCapInvalid }),
});

export type SpendingCapBody = z.infer<typeof spendingCapSchema>;
