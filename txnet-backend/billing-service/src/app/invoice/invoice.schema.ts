import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { RENEWAL_DAYS_MAX, RENEWAL_GIB_MAX } from '../catalog/renewal-rate.schema';

const E = BackendI18nKeys.errors.billing;

/**
 * What a shopper sends to be invoiced (F-111-a): the variant and the codes typed —
 * and, for a renewal of a Grant they hold, its id (F-305-c), with the plan as
 * `variantId` or GiB and days typed in its place (F-305-e).
 *
 * **No price, and not strict.** Spec §5.8 says a client-submitted price is
 * ignored, not merely validated — so a `price`, `amount` or `total` in the body
 * is stripped here and never reaches the service, whose request type has no
 * field to carry one. Refusing it would make the client's number part of the
 * contract; ignoring it keeps the catalog the only source.
 */
/** GiB and days typed for a renewal (F-305-e): whole, within catalog's widest bounds (`renewal-rate.schema.ts`). */
const typedPart = (max: number) => z.number({ message: E.invoice.customOutOfBounds }).int({ message: E.invoice.customOutOfBounds }).min(0).max(max, { message: E.invoice.customOutOfBounds });

export const invoiceCreateSchema = z
  .object({
    variantId: z.string({ message: E.invoice.variantInvalid }).uuid({ message: E.invoice.variantInvalid }).optional(),
    couponCodes: z
      .array(z.string({ message: E.couponCodesInvalid }).max(64, { message: E.couponCodesInvalid }), {
        message: E.couponCodesInvalid,
      })
      .max(10, { message: E.couponCodesInvalid })
      .default([]),
    /** A Grant the caller holds: `variantId` is then the plan it renews to (F-305-c, ADR-0158). */
    grantId: z.string({ message: E.invoice.grantNotFound }).uuid({ message: E.invoice.grantNotFound }).optional(),
    /** With `grantId`, in place of `variantId`: GiB and days at the product's renewal rate (F-305-e). */
    gib: typedPart(RENEWAL_GIB_MAX).optional(),
    days: typedPart(RENEWAL_DAYS_MAX).optional(),
  })
  // One thing is invoiced: a variant (bought, or a plan renewed to), or GiB and days typed on a Grant.
  .refine((b) => (b.variantId === undefined) === (b.gib !== undefined && b.days !== undefined && b.grantId !== undefined), {
    message: E.invoice.variantInvalid,
    path: ['variantId'],
  });

/** The typed renewal's quote (F-305-e): `?gib=&days=`, the parts as the invoice takes them. */
const queryPart = (max: number) =>
  z.coerce.number({ message: E.invoice.customOutOfBounds }).int({ message: E.invoice.customOutOfBounds }).min(0, { message: E.invoice.customOutOfBounds }).max(max, { message: E.invoice.customOutOfBounds });

export const renewalQuoteSchema = z.object({ gib: queryPart(RENEWAL_GIB_MAX), days: queryPart(RENEWAL_DAYS_MAX) });

export type RenewalQuoteQuery = z.infer<typeof renewalQuoteSchema>;

export type InvoiceCreateBody = z.infer<typeof invoiceCreateSchema>;
