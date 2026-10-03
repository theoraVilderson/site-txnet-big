import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { RATING_COMMENT_MAX } from './lifecycle';

const invalid = BackendI18nKeys.errors.validation.failed;

/** `POST /api/support/conversations/:id/rating`. The bounds are also the service's and a CHECK's. */
export const ratingSchema = z
  .object({
    score: z.number().int(invalid).min(1, invalid).max(5, invalid),
    comment: z.string().max(RATING_COMMENT_MAX, invalid).optional(),
  })
  .strict();

/** `PUT /api/support/settings/lifecycle` — `null` is the platform's; both `null` drops the tenant's row. Bounds are the service's. */
export const lifecycleSchema = z
  .object({
    autoCloseAfterDays: z.number().int(invalid).nullable(),
    reopenWithinDays: z.number().int(invalid).nullable(),
  })
  .strict();

export type RatingBody = { score: number; comment?: string };
export type LifecycleBody = { autoCloseAfterDays: number | null; reopenWithinDays: number | null };
