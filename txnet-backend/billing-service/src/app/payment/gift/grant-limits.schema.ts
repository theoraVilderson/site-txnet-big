import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { MAX_METERED_CAP } from '../../entitlement/metered-cap';

const E = BackendI18nKeys.errors.billing;

/** A cap of open metered Grants (F-118-ap): a whole number, 0 (sells none) up to a bound that catches a typo. */
export const grantLimitSchema = z
  .number({ message: E.grantLimitInvalid })
  .int({ message: E.grantLimitInvalid })
  .min(0, { message: E.grantLimitInvalid })
  .max(MAX_METERED_CAP, { message: E.grantLimitInvalid });

/** `PUT …/tenants/:tenantId/grant-limits`: the tenant's default, or `null` for the platform's. Required, so an empty body changes nothing by accident. */
export const tenantGrantLimitSchema = z.object({ meteredOpenCap: grantLimitSchema.nullable() }).strict();

/** `PUT …/users/:userId/grant-limit`: one user's number, and why — the ticket, in a line. Kept on the row and its audit. */
export const userGrantLimitSchema = z
  .object({
    meteredOpenCap: grantLimitSchema,
    reason: z.string({ message: E.grantLimitInvalid }).trim().min(1, { message: E.grantLimitInvalid }).max(500, { message: E.grantLimitInvalid }),
  })
  .strict();

export type TenantGrantLimitBody = z.infer<typeof tenantGrantLimitSchema>;
export type UserGrantLimitBody = z.infer<typeof userGrantLimitSchema>;
