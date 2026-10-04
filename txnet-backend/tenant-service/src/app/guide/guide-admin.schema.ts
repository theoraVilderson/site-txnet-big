import { GuideKind, GuideSurface, GuideTargetKind, Language } from '@prisma/client';
import { BackendI18nKeys, guideBlocksSchema } from '@txnet-backend/shared-core';
import { z } from 'zod';

import type { CreateGuideInput, GuidePlacementInput, GuideText } from './guide-admin';
import { GUIDE_KEY } from './guide-public.schema';

const invalid = BackendI18nKeys.errors.validation.failed;

const texts = z
  .array(
    z
      .object({
        lang: z.nativeEnum(Language, { message: invalid }),
        title: z.string().trim().min(1, invalid).max(120, invalid),
        blocks: guideBlocksSchema,
      })
      .strict(),
  )
  .min(1, invalid)
  .max(Object.keys(Language).length, invalid);

const placements = z
  .array(
    z
      .object({
        surface: z.nativeEnum(GuideSurface, { message: invalid }),
        targetKind: z.nativeEnum(GuideTargetKind, { message: invalid }),
        targetRef: z.string().min(1, invalid).max(64, invalid),
      })
      .strict(),
  )
  .max(50, invalid);

const sortOrder = z.number().int(invalid).min(0, invalid).max(10_000, invalid);

/** `POST /api/guides/settings` — a new guide, its texts as the draft. A slot or a file is the service's to refuse. */
export const createGuideSchema = z
  .object({
    key: z.string().regex(GUIDE_KEY, invalid),
    kind: z.nativeEnum(GuideKind, { message: invalid }),
    sortOrder: sortOrder.optional(),
    texts,
    placements: placements.optional(),
  })
  .strict();

/** `PATCH …/:id` — kind and order; the key never changes. */
export const updateGuideSchema = z
  .object({ kind: z.nativeEnum(GuideKind, { message: invalid }), sortOrder })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, invalid);

/** `PUT …/:id/draft` — every language at once. */
export const draftSchema = z.object({ texts }).strict();

/** `PUT …/:id/placements` — every placement at once; `[]` places it nowhere. */
export const placementsSchema = z.object({ placements }).strict();

/** `GET …/:id/preview?lang=` — the caller's language when absent. */
export const previewQuerySchema = z.object({ lang: z.nativeEnum(Language, { message: invalid }).optional() }).strict();

export type CreateGuideBody = CreateGuideInput;
export type DraftBody = { texts: GuideText[] };
export type PlacementsBody = { placements: GuidePlacementInput[] };
