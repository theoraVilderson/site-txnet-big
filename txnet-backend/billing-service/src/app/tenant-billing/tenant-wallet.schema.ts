import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const E = BackendI18nKeys.errors.billing;

/**
 * The billing page's paging (F-019-d), as query parameters. The same rules as
 * the wallet history's: absent is the service's default, a page the caller
 * did send and cannot have is a 400.
 */
export const tenantWalletSchema = z
  .object({
    page: z.coerce.number({ message: E.pageInvalid }).int().positive().optional(),
    pageSize: z.coerce.number({ message: E.pageInvalid }).int().positive().max(100).optional(),
  })
  .strict();

export type TenantWalletQueryBody = z.infer<typeof tenantWalletSchema>;
