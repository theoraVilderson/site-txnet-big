import { GuideSurface, GuideTargetKind } from '@prisma/client';
import { BackendI18nKeys, guideSlotRefusal } from '@txnet-backend/shared-core';
import { z } from 'zod';

import type { GuidePlacementQuery } from './guide-reader';

const invalid = BackendI18nKeys.errors.validation.failed;

/** A guide's key, the database's own bound (`guide/data-model.md`). */
export const GUIDE_KEY = /^[a-z0-9_]{1,60}$/;

export const guideKeySchema = z.string().regex(GUIDE_KEY, invalid);

/**
 * `?placement=<targetKind>:<targetRef>&surface=panel|bot` (F-414-b). Only a
 * registered slot (ADR-0116 point 2): anything else could never match a row,
 * and refusing it keeps junk out of the cache's keys.
 */
export const guideListQuerySchema = z
  .object({
    placement: z.string().regex(/^[a-z_]+:[a-z0-9][a-z0-9_-]{0,63}$/, invalid),
    // `any` is a placement's, never a reader's: a reader is on one surface.
    surface: z.nativeEnum(GuideSurface).refine((v) => v !== GuideSurface.any, invalid).default(GuideSurface.panel),
  })
  .strict()
  .transform((q, ctx): GuidePlacementQuery => {
    const [targetKind, targetRef] = q.placement.split(':') as [GuideTargetKind, string];
    const placement = { targetKind, targetRef, surface: q.surface as GuidePlacementQuery['surface'] };
    if (!Object.values(GuideTargetKind).includes(targetKind) || guideSlotRefusal(placement)) {
      ctx.addIssue({ code: 'custom', path: ['placement'], message: invalid });
      return z.NEVER;
    }
    return placement;
  });
