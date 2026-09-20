import { CampaignStatus } from '@prisma/client';
import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { audienceFilterSchema, campaignDraftShape } from './campaign-admin.schema';

/** The same generic refusal every campaign shape uses (F-035-c). */
const invalid = BackendI18nKeys.errors.validation.failed;

/**
 * The reseller-named campaign surface's wire shapes (F-313-d).
 *
 * **Each one is `.strict()` and none of them carries a `tenantId`.** The path
 * names the reseller and `ResellerAccess` admits the caller to it; a body or
 * query that named one too would be a second answer to a question already
 * answered, and the two can disagree. `campaign-admin.schema.ts`'s own shapes
 * keep their `tenantId` because there the caller's tenant is the only scope
 * there is — this file is the difference between the two doors, not a copy.
 *
 * **No `z.infer` body types.** `strictNullChecks` is off across the workspace,
 * which makes every inferred field optional; bodies are therefore typed as the
 * service's own inputs and guaranteed by the pipe, exactly as
 * `campaign-admin.controller.ts` says.
 */

/** Drafting: the shared draft shape, with no scope — the path already fixed it. */
export const resellerCreateCampaignSchema = z.object(campaignDraftShape).strict(invalid);

/**
 * Sizing a segment before it is sent. A `POST` with the filter in the body
 * rather than a `GET` with it in the query: the audience is a nested object
 * with lists in it, and spelling that into query parameters is a second
 * encoding of a shape `audienceFilterSchema` already closes. It reads nothing
 * but a count and writes nothing, which is why it is admitted as a `read`.
 */
export const audienceCountSchema = z.object({ audience: audienceFilterSchema }).strict(invalid);

/** Listing: paging and a status, never another tenant's rows. */
export const resellerListCampaignsSchema = z
  .object({
    page: z.coerce.number({ message: invalid }).int({ message: invalid }).positive({ message: invalid }).optional(),
    pageSize: z.coerce.number({ message: invalid }).int({ message: invalid }).positive({ message: invalid }).max(100, { message: invalid }).optional(),
    status: z.nativeEnum(CampaignStatus, { message: invalid }).optional(),
  })
  .strict(invalid);

export type ResellerListCampaignsQuery = z.infer<typeof resellerListCampaignsSchema>;
