import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const E = BackendI18nKeys.errors.billing;

/**
 * What a shopper sends to be invoiced (F-111-a): the variant and the codes typed.
 *
 * **No price, and not strict.** Spec §5.8 says a client-submitted price is
 * ignored, not merely validated — so a `price`, `amount` or `total` in the body
 * is stripped here and never reaches the service, whose request type has no
 * field to carry one. Refusing it would make the client's number part of the
 * contract; ignoring it keeps the catalog the only source.
 */
export const invoiceCreateSchema = z.object({
  variantId: z.string({ message: E.invoice.variantInvalid }).uuid({ message: E.invoice.variantInvalid }),
  couponCodes: z
    .array(z.string({ message: E.couponCodesInvalid }).max(64, { message: E.couponCodesInvalid }), {
      message: E.couponCodesInvalid,
    })
    .max(10, { message: E.couponCodesInvalid })
    .default([]),
});

export type InvoiceCreateBody = z.infer<typeof invoiceCreateSchema>;
