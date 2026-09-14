import { BackendI18nKeys, GATEWAY_CREDENTIAL_SOURCES } from '@txnet-backend/shared-core';
import { z } from 'zod';

const E = BackendI18nKeys.errors.billing;

/** Base currency, a decimal string with at most 2 places — never a JSON number (C-02). `Decimal(18, 2)` bounds the digits. */
const AMOUNT = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const ZERO = /^0(\.0{1,2})?$/;

export const depositQuoteSchema = z.object({
  gatewayId: z.string({ message: E.gatewayInvalid }).uuid({ message: E.gatewayInvalid }),
  /** The table the id is from, as the gateway list answered it (D-25). */
  source: z.enum(GATEWAY_CREDENTIAL_SOURCES, { message: E.gatewayInvalid }).default('tenant'),
  amount: z
    .string({ message: E.amountInvalid })
    .regex(AMOUNT, { message: E.amountInvalid })
    .refine((v) => !ZERO.test(v), { message: E.amountInvalid }),
  couponCodes: z
    .array(z.string({ message: E.couponCodesInvalid }).max(64, { message: E.couponCodesInvalid }), {
      message: E.couponCodesInvalid,
    })
    .max(10, { message: E.couponCodesInvalid })
    .default([]),
});

export type DepositQuoteBody = z.infer<typeof depositQuoteSchema>;

/**
 * Starting a top-up takes exactly what quoting it took (F-092-i): the payment
 * is priced from the same inputs by the same code, so a body that could quote
 * and not pay would be a way for the two to disagree.
 */
export const depositStartSchema = depositQuoteSchema;

export type DepositStartBody = z.infer<typeof depositStartSchema>;
