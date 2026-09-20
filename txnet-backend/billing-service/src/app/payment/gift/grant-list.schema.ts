import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const E = BackendI18nKeys.errors.billing;

/**
 * The query of `GET /api/billing/gift/grants` (F-502-r): paging, and nothing
 * else. **Whose Grants is not here** — the user is the gate's `X-User-Id`, so
 * there is no id in this schema to authorise, exactly as on the financial page
 * (`wallet-history.schema.ts`).
 *
 * Paging names no default, for the reason that file records: `z.infer` marks a
 * defaulted key optional in this workspace, so a `.default()` here would
 * promise the type system a number it cannot see. The schema's job is to refuse
 * a page the caller *did* send and cannot have; what an absent one means is
 * `GrantService.listForUser`'s to decide, once.
 */
export const grantListSchema = z.object({
  page: z.coerce.number({ message: E.pageInvalid }).int().positive().optional(),
  pageSize: z.coerce.number({ message: E.pageInvalid }).int().positive().max(100).optional(),
});

export type GrantListQuery = z.infer<typeof grantListSchema>;
