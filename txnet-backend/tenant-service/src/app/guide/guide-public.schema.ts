import { GuideSurface, GuideTargetKind } from '@prisma/client';
import { BackendI18nKeys, guideSlotRefusal } from '@txnet-backend/shared-core';
import { z } from 'zod';

import type { GuidePlacementQuery } from './guide-reader';
import { GUIDE_MATCHES } from './guide-search';
import { GUIDE_STATS_DAYS } from './guide-stats';

const invalid = BackendI18nKeys.errors.validation.failed;

/** A guide's key, the database's own bound (`guide/data-model.md`). */
export const GUIDE_KEY = /^[a-z0-9_]{1,60}$/;

export const guideKeySchema = z.string().regex(GUIDE_KEY, invalid);

/**
 * `?placement=<targetKind>:<targetRef>&surface=panel|bot` (F-414-b). Only a
 * registered slot (ADR-0116 point 2): anything else could never match a row,
 * and refusing it keeps junk out of the cache's keys.
 */
const listQuery = z.object({
  placement: z.string().regex(/^[a-z_]+:[a-z0-9][a-z0-9_-]{0,63}$/, invalid),
  // `any` is a placement's, never a reader's: a reader is on one surface.
  surface: z.nativeEnum(GuideSurface).refine((v) => v !== GuideSurface.any, invalid).default(GuideSurface.panel),
});

function toPlacement(q: z.infer<typeof listQuery>, ctx: z.RefinementCtx): GuidePlacementQuery {
  const [targetKind, targetRef] = q.placement.split(':') as [GuideTargetKind, string];
  const placement = { targetKind, targetRef, surface: q.surface as GuidePlacementQuery['surface'] };
  if (!Object.values(GuideTargetKind).includes(targetKind) || guideSlotRefusal(placement)) {
    ctx.addIssue({ code: 'custom', path: ['placement'], message: invalid });
    return z.NEVER;
  }
  return placement;
}

export const guideListQuerySchema = listQuery.strict().transform(toPlacement);

/** The bot's read (F-414-f): the same slot, for a tenant named by id rather than by Host. */
export const guideInternalListQuerySchema = listQuery
  .extend({ tenantId: z.string().uuid(invalid) })
  .strict()
  .transform((q, ctx) => ({ tenantId: q.tenantId, ...toPlacement(q, ctx) }));

export const guideInternalOneQuerySchema = z.object({ tenantId: z.string().uuid(invalid) }).strict();

const readerSurface = z.nativeEnum(GuideSurface).refine((v) => v !== GuideSurface.any, invalid).default(GuideSurface.panel);

const searchMatch = z.enum(GUIDE_MATCHES).default('all');

/** `?q=&surface=&match=` (F-414-j; `match=any` for a support message, F-414-k): 2–100 characters, on the surface the reader is on. */
export const guideSearchQuerySchema = z
  .object({ q: z.string().trim().min(2, invalid).max(100, invalid), surface: readerSurface, match: searchMatch })
  .strict()
  .transform((v) => ({ q: v.q, surface: v.surface as Exclude<GuideSurface, 'any'>, match: v.match }));

/** The bot's search (F-414-k): the same, for a tenant named by id. */
export const guideInternalSearchQuerySchema = z
  .object({ tenantId: z.string().uuid(invalid), q: z.string().trim().min(2, invalid).max(100, invalid), surface: readerSurface, match: searchMatch })
  .strict()
  .transform((v) => ({ tenantId: v.tenantId, q: v.q, surface: v.surface as Exclude<GuideSurface, 'any'>, match: v.match }));

/** The bot's view (F-414-l): the chat, as the bot names it; hashed before it is kept. */
export const guideInternalViewQuerySchema = z.object({ tenantId: z.string().uuid(invalid) }).strict();
export const guideInternalViewBodySchema = z.object({ viewer: z.string().min(1, invalid).max(200, invalid) }).strict();

/** A known user's vote (F-414-l): helpful or not. */
export const guideVoteBodySchema = z.object({ helpful: z.boolean({ message: invalid }) }).strict();

/** `?days=7|30|90` on the numbers (F-414-l); 30 when left out. */
export const guideStatsQuerySchema = z
  .object({ days: z.enum(GUIDE_STATS_DAYS).default('30') })
  .strict()
  .transform((q) => ({ days: Number(q.days) }));
