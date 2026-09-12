import { z } from 'zod';

/**
 * The wire shapes of the operator surface (F-096-e).
 *
 * **No `i18nKey` on any message here, unlike every other billing schema.** This
 * is the platform owner's own back office, not a tenant's user-facing screen —
 * the same reason `auth-service`'s `worker-admin.schema.ts` carries none — and
 * C-01 puts the operator's language in English.
 *
 * `tenantId` is in the body on every route. That is not the drift it looks
 * like: on every other billing route the tenant is *the caller's* and comes
 * from the gate's header, which is why taking it from a body would be a bug.
 * Here the caller is always the platform owner and the tenant named is the
 * **subject** — who is borrowing, who is being paid. The two are never the same
 * value, and `SettlementService.assertOperator` is what keeps the caller's own
 * tenant authoritative.
 */

/** Base currency, a decimal string with at most 2 places — never a JSON number (C-02). */
const AMOUNT = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;

const uuid = (what: string) => z.string({ message: `${what} must be a uuid` }).uuid({ message: `${what} must be a uuid` });

export const createGrantSchema = z
  .object({
    /** The **borrowing** tenant — the one the grant is to (ADR-0041 §2). */
    tenantId: uuid('tenantId'),
    gatewayId: uuid('gatewayId').nullish(),
    tenantGatewayConfigId: uuid('tenantGatewayConfigId').nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  // The CHECK constraint on `payment_gateway_grant`, restated at the surface so
  // a malformed grant is a 400 naming the field rather than a 500 from
  // Postgres. The service checks it again, because it is reachable from a
  // second controller later and the rule belongs to the grant, not the route.
  .refine(
    (b) => [b.gatewayId, b.tenantGatewayConfigId].filter(Boolean).length === 1,
    { message: 'name exactly one of gatewayId (a platform gateway) or tenantGatewayConfigId (another tenant\'s)' },
  );

export const recordPayoutSchema = z.object({
  /** The tenant being paid. */
  tenantId: uuid('tenantId'),
  amount: z
    .string({ message: 'amount must be a decimal string with at most 2 places' })
    .regex(AMOUNT, { message: 'amount must be a decimal string with at most 2 places' }),
  method: z.string().trim().max(100).nullish(),
  reference: z.string().trim().max(200).nullish(),
  /**
   * A key the operator types, stored verbatim and resolved by nothing (F-033).
   * Bounded like the other free text so the column cannot be used as a notes
   * field by accident.
   */
  proofAttachmentKey: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(1000).nullish(),
});

export const listGrantsSchema = z.object({
  tenantId: uuid('tenantId').optional(),
});

export type CreateGrantBody = z.infer<typeof createGrantSchema>;
export type RecordPayoutBody = z.infer<typeof recordPayoutSchema>;
export type ListGrantsQuery = z.infer<typeof listGrantsSchema>;
