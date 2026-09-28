import { GrantStatus } from '@prisma/client';
import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { grantBulkSchema } from './grant-bulk.schema';
import { grantListSchema } from './grant-list.schema';

const E = BackendI18nKeys.errors.billing;

const id = z.string({ message: E.configActionInvalid }).uuid({ message: E.configActionInvalid });

/**
 * Which of the reseller's Grants a job acts on (F-311-u2): every condition
 * given must hold. A panel is a Grant with a config on it that is not being
 * removed; a product or a variant is what it was issued from. `statuses`
 * defaults to `active` — "every active Grant" is `{}`; an unfreeze names
 * `suspended`.
 */
export const grantBulkFilterSchema = z
  .object({
    panelId: id.optional(),
    productId: id.optional(),
    variantId: id.optional(),
    statuses: z.array(z.nativeEnum(GrantStatus, { message: E.configActionInvalid }), { message: E.configActionInvalid }).min(1, { message: E.configActionInvalid }).max(6, { message: E.configActionInvalid }).default([GrantStatus.active]),
  })
  .strict();

export type GrantBulkFilter = z.infer<typeof grantBulkFilterSchema>;

/** `POST …/grants/bulk-jobs/count`: how many Grants a filter matches now, so the confirm shows it. */
export const grantBulkCountSchema = z.object({ filter: grantBulkFilterSchema }).strict();

/**
 * The body of `POST …/grants/bulk-jobs` (F-311-u2): a bulk-by-id body
 * (`grant-bulk.schema.ts`, the same actions, bounds and required `requestId`
 * and `reason`) with a `filter` where its `grantIds` were.
 */
export const grantBulkJobSchema = z.discriminatedUnion(
  'action',
  // Each by-id option with `filter` for `grantIds`; the tuple type is lost in the map, so the body's type is spelled below.
  (grantBulkSchema.options as readonly z.AnyZodObject[]).map((o) => o.omit({ grantIds: true }).extend({ filter: grantBulkFilterSchema }).strict()) as unknown as [
    z.ZodDiscriminatedUnionOption<'action'>,
    ...z.ZodDiscriminatedUnionOption<'action'>[],
  ],
  { message: E.configActionInvalid },
);

/** Typed from the by-id body, so an action added there is an action here. */
export type GrantBulkJobBody = (z.infer<typeof grantBulkSchema> extends infer B ? (B extends unknown ? Omit<B, 'grantIds'> : never) : never) & { filter: GrantBulkFilter };

/** A query flag as it arrives: the text of a boolean. */
const FLAG = ['true', 'false'] as const;

/** `GET …/bulk-jobs` and `…/bulk-jobs/:jobId/outcomes`: a page as every reseller list's; `problems` keeps only refused and failed Grants. */
export const grantBulkPageSchema = z.object({
  page: grantListSchema.shape.page,
  pageSize: grantListSchema.shape.pageSize,
  problems: z.enum(FLAG, { message: E.pageInvalid }).optional().transform((v) => v === 'true'),
});

export type GrantBulkPage = z.infer<typeof grantBulkPageSchema>;
