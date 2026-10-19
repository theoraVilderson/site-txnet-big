import { RateLimitBucket, type ResellerAccessRejection, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { type RefusalStatus, refusalException } from '../../request/refusal-exception';
import { ManualConfirmRefused, type ManualConfirmRejection, ResellerManualConfirmRefused } from './manual-confirm.refusals';

/** Reads of the queue, per person — one budget for the ambient and the named-reseller routes (F-093-v). */
export const MANUAL_READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.PAYMENT_MANUAL_READ, identityOf(req).userId),
  configKey: 'PAYMENT_MANUAL_READ_RATE_LIMIT' as const,
  windowSec: 900,
};

/** Acts on a payment, per person, on either surface. */
export const MANUAL_WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.PAYMENT_MANUAL_WRITE, identityOf(req).userId),
  configKey: 'PAYMENT_MANUAL_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ManualConfirmRejection | ResellerAccessRejection, RefusalStatus> = {
  payment_not_found: 404,
  receipt_missing: 404,
  reference_required: 400,
  not_open: 409,
  authority_present: 409,
  authority_taken: 409,
  duplicate_ref: 409,
  cannot_return: 409,
  // ResellerAccess (invariant 21), on the named-reseller routes only.
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
};

/** The one place manual confirmation turns a refusal into a status; the reason travels in the body. */
export async function manualRefusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof ManualConfirmRefused) && !(e instanceof ResellerManualConfirmRefused)) throw e;
    throw refusalException(STATUS[e.reason], { reason: e.reason, message: e.message });
  }
}
