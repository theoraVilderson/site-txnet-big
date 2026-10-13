import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { MAX_COMPENSATION_CAP } from './grant-compensation';

const E = BackendI18nKeys.errors.billing;

/** 1 GiB: the catalog's traffic unit. */
const GIB = 1024 ** 3;
const MAX_GB = Number(MAX_COMPENSATION_CAP.bytes / BigInt(GIB));

const reason = z.string({ message: E.configActionInvalid }).trim().min(1, { message: E.configActionInvalid }).max(500, { message: E.configActionInvalid });

/**
 * The body of `POST …/users/:userId/grants/:grantId/compensate` (KS-1-c):
 * exactly one of `days` (whole, > 0) or `gb` (> 0 GiB, fractions allowed),
 * and the `reason` the act keeps. Whether it fits the cap is `claimCompensation`'s.
 */
export const grantCompensateSchema = z
  .object({
    days: z.number({ message: E.configActionInvalid }).int({ message: E.configActionInvalid }).min(1, { message: E.configActionInvalid }).max(MAX_COMPENSATION_CAP.days).optional(),
    gb: z
      .number({ message: E.configActionInvalid })
      .finite({ message: E.configActionInvalid })
      .max(MAX_GB, { message: E.configActionInvalid })
      .refine((gb) => Math.round(gb * GIB) > 0, { message: E.configActionInvalid })
      .optional(),
    reason,
  })
  .strict()
  .refine((b) => (b.days === undefined) !== (b.gb === undefined), { message: E.configActionInvalid });

export type GrantCompensateBody = z.infer<typeof grantCompensateSchema>;

/**
 * `PUT …/tenants/:tenantId/compensation-cap` (KS-1-c): `days` and `gb` per
 * Grant over 30 days, 0 closing that kind, or `cap: null` for the platform's.
 * Required, so an empty body changes nothing by accident.
 */
export const compensationCapSchema = z
  .object({
    cap: z
      .object({
        days: z.number({ message: E.configActionInvalid }).int({ message: E.configActionInvalid }).min(0).max(MAX_COMPENSATION_CAP.days, { message: E.configActionInvalid }),
        gb: z.number({ message: E.configActionInvalid }).finite({ message: E.configActionInvalid }).min(0).max(MAX_GB, { message: E.configActionInvalid }),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type CompensationCapBody = z.infer<typeof compensationCapSchema>;
