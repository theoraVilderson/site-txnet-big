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

/** A messenger's amount: a positive integer in the currency's smallest unit, as a string (JSON has no bigint). */
const MINOR = /^[1-9]\d{0,18}$/;

/**
 * What the bot relays from `pre_checkout_query` (F-104-k): the invoice payload
 * is the payment id `start` answered. A malformed relay is the bot's bug, so
 * the keys are the generic ones.
 */
export const inChatPreCheckoutSchema = z.object({
  paymentId: z.string({ message: E.gatewayInvalid }).uuid({ message: E.gatewayInvalid }),
  currency: z.string({ message: E.amountInvalid }).regex(/^[A-Z0-9]{2,20}$/, { message: E.amountInvalid }),
  totalAmount: z.string({ message: E.amountInvalid }).regex(MINOR, { message: E.amountInvalid }),
});

export type InChatPreCheckoutBody = z.infer<typeof inChatPreCheckoutSchema>;

/** `successful_payment`, plus the platform's charge id — the settlement reference. */
export const inChatPaidSchema = inChatPreCheckoutSchema.extend({
  chargeId: z.string({ message: E.gatewayInvalid }).min(1, { message: E.gatewayInvalid }).max(255, { message: E.gatewayInvalid }),
});

export type InChatPaidBody = z.infer<typeof inChatPaidSchema>;
