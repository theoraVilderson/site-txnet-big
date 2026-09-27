import { BackendI18nKeys } from '@txnet-backend/shared-core';
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
  })
  .strict();
