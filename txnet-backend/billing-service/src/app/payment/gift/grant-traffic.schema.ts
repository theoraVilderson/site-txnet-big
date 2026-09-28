import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const E = BackendI18nKeys.errors.billing;

/** 1 GiB: the catalog's traffic unit, and the renewal's (`renewal.ts`). */
const GIB = 1024 ** 3;

/**
 * The body of `POST …/users/:userId/grants/:grantId/traffic` (F-311-j): `gb`,
 * the change in GiB (±, never 0, fractions allowed, at most 100 000 either
 * way), and the `reason` its adjustment row keeps. Whether a cut goes below
 * zero is `adjustGrantTraffic`'s to decide, against the Quota it reads.
 */
export const grantTrafficSchema = z
  .object({
    gb: z
      .number({ message: E.configActionInvalid })
      .finite({ message: E.configActionInvalid })
      .min(-100_000, { message: E.configActionInvalid })
      .max(100_000, { message: E.configActionInvalid })
      .refine((gb) => Math.round(gb * GIB) !== 0, { message: E.configActionInvalid }),
    reason: z.string({ message: E.configActionInvalid }).trim().min(1, { message: E.configActionInvalid }).max(500, { message: E.configActionInvalid }),
  })
  .strict();

export type GrantTrafficBody = z.infer<typeof grantTrafficSchema>;

/** The body's GiB as the bytes the Grant is moved by. */
export const bytesOfGb = (gb: number): bigint => BigInt(Math.round(gb * GIB));
