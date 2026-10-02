import { BackendI18nKeys, SUGGESTION_NOTICE } from '@txnet-backend/shared-core';
import { z } from 'zod';

const invalid = BackendI18nKeys.errors.validation.failed;

/**
 * The retention ledger's claim (F-601-a). Strict: the caller is worker-service,
 * and a key it sends that this side ignores is a rule one of them thinks holds.
 * `notice` is an outbox event type; `period` the producer's opaque name for the
 * Grant's current period.
 */
export const retentionClaimSchema = z
  .object({
    eventId: z.string({ message: invalid }).uuid({ message: invalid }),
    userId: z.string({ message: invalid }).uuid({ message: invalid }),
    grantId: z.string({ message: invalid }).uuid({ message: invalid }),
    notice: z.string({ message: invalid }).regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, { message: invalid }).max(100, { message: invalid }),
    period: z.string({ message: invalid }).min(1, { message: invalid }).max(100, { message: invalid }),
    // F-601-p: a patient notice may wait this long for the user's other services.
    waitSec: z.number({ message: invalid }).int({ message: invalid }).min(1, { message: invalid }).max(3600, { message: invalid }).optional(),
  })
  .strict();

/**
 * F-038-g1: an AI suggestion's claim — worker-service, once per `ai.action`.
 * F-038-g5: `grantId` left out for a suggestion about no service (`checkout_help`).
 */
export const suggestionClaimSchema = z
  .object({
    actionId: z.string({ message: invalid }).uuid({ message: invalid }),
    userId: z.string({ message: invalid }).uuid({ message: invalid }),
    grantId: z.string({ message: invalid }).uuid({ message: invalid }).optional(),
  })
  .strict();

/**
 * A claimed notice's bot message, kept for the end of the user's quiet hours
 * (F-601-m): the row's key and the event holding it, the words to tell, and
 * the `botAt` the claim answered.
 */
export const retentionHoldSchema = retentionClaimSchema
  .omit({ userId: true, waitSec: true })
  .extend({
    // F-038-g5: only a suggestion's row may have no Grant — a retention notice is always about one.
    grantId: z.string({ message: invalid }).uuid({ message: invalid }).optional(),
    tenantId: z.string({ message: invalid }).uuid({ message: invalid }),
    template: z.string({ message: invalid }).regex(/^[A-Za-z0-9]+$/, { message: invalid }).max(100, { message: invalid }),
    params: z.record(z.string({ message: invalid }), z.string({ message: invalid }).max(2000, { message: invalid }), { message: invalid }),
    botAt: z.string({ message: invalid }).datetime({ message: invalid }),
  })
  .strict()
  .refine((h) => h.grantId !== undefined || h.notice === SUGGESTION_NOTICE, { message: invalid, path: ['grantId'] });

/** A take of held bot messages now due (F-601-m). */
export const heldTakeSchema = z.object({ limit: z.number({ message: invalid }).int({ message: invalid }).min(1, { message: invalid }).max(500, { message: invalid }) }).strict();

/** The held messages a take told. */
export const heldToldSchema = z
  .object({ ids: z.array(z.string({ message: invalid }).uuid({ message: invalid }), { message: invalid }).min(1, { message: invalid }).max(500, { message: invalid }) })
  .strict();
