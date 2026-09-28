import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { GRANT_LIST_SCOPES } from '../../entitlement/grant';
import { MAX_CONFIG_LABEL_LENGTH } from '../../traffic/line-names';

const E = BackendI18nKeys.errors.billing;

/**
 * The query of `GET /api/billing/gift/grants` (F-502-r): paging, the
 * scope — `current` or `all`, absent meaning `current` (`GrantService.listForUser`) —
 * and `q` (F-307-m, F-307-x), a piece of a service's or a config's name; blank is no search. **Whose Grants is not here** — the user is the gate's `X-User-Id`, so
 * there is no id in this schema to authorise, exactly as on the financial page
 * (`wallet-history.schema.ts`).
 *
 * Paging names no default, for the reason that file records: `z.infer` marks a
 * defaulted key optional in this workspace, so a `.default()` here would
 * promise the type system a number it cannot see. The schema's job is to refuse
 * a page the caller *did* send and cannot have; what an absent one means is
 * `GrantService.listForUser`'s to decide, once.
 */
/** Longer than a label or a template can make a line name (40 each, plus a brand and a region), so it can match nothing. */
export const GRANT_LIST_QUERY_MAX = 100;

export const grantListSchema = z.object({
  page: z.coerce.number({ message: E.pageInvalid }).int().positive().optional(),
  pageSize: z.coerce.number({ message: E.pageInvalid }).int().positive().max(100).optional(),
  scope: z.enum(GRANT_LIST_SCOPES, { message: E.historyFilterInvalid }).optional(),
  q: z.string({ message: E.historyFilterInvalid }).trim().max(GRANT_LIST_QUERY_MAX, { message: E.historyFilterInvalid }).optional(),
});

export type GrantListQuery = z.infer<typeof grantListSchema>;

/** How many lines one paste may carry: a Grant holds up to 20 configs (user, 2026-09-26). */
export const GRANTS_BY_LINES_MAX = 20;
/** Longer than any line a panel captures (a reality line is a few hundred characters). */
export const PASTED_LINE_MAX = 4096;

/**
 * The body of `POST /api/billing/gift/grants/by-lines` (F-307-p): pasted config
 * lines, and the list's paging and scope. **A body, never a query string** — a
 * line is a credential, and a URL lands in access logs and browser history.
 */
export const grantsByLinesSchema = z.object({
  lines: z
    .array(z.string({ message: E.historyFilterInvalid }).trim().min(1, { message: E.historyFilterInvalid }).max(PASTED_LINE_MAX, { message: E.historyFilterInvalid }), {
      message: E.historyFilterInvalid,
    })
    .min(1, { message: E.historyFilterInvalid })
    .max(GRANTS_BY_LINES_MAX, { message: E.historyFilterInvalid }),
  page: grantListSchema.shape.page,
  pageSize: grantListSchema.shape.pageSize,
  scope: grantListSchema.shape.scope,
});

export type GrantsByLinesBody = z.infer<typeof grantsByLinesSchema>;

/**
 * The body of `PUT /api/billing/gift/grants/:grantId/label` (F-307-x): the
 * buyer's name for a service, trimmed, 1..40 characters — a config label's
 * rule (`configLabelSchema`), so either name fits wherever the other does. An
 * empty or `null` label is the catalog's name again.
 */
export const grantLabelSchema = z.object({
  label: z
    .string({ message: E.serviceLabelInvalid })
    .trim()
    .max(MAX_CONFIG_LABEL_LENGTH, { message: E.serviceLabelInvalid })
    .nullable()
    .transform((label) => (label === '' ? null : label)),
});

export type GrantLabelBody = z.infer<typeof grantLabelSchema>;
