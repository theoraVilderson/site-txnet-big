import { Language } from '@prisma/client';
import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { CATEGORY_KEY, CATEGORY_NAME_MAX, CategoryInput } from './categories';

const invalid = BackendI18nKeys.errors.validation.failed;

const texts = z
  .array(
    z
      .object({
        lang: z.nativeEnum(Language, { message: invalid }),
        name: z.string().trim().min(1, invalid).max(CATEGORY_NAME_MAX, invalid),
      })
      .strict(),
  )
  .max(Object.keys(Language).length, invalid);

const fields = {
  key: z.string().regex(CATEGORY_KEY, invalid),
  sortOrder: z.number().int(invalid).min(0, invalid).max(10_000, invalid),
  isActive: z.boolean({ message: invalid }),
  texts,
};

/** `POST /api/support/settings/categories`. No language, or one twice, is the service's to refuse (`category_invalid`). */
export const createCategorySchema = z
  .object({ key: fields.key, sortOrder: fields.sortOrder.optional(), isActive: fields.isActive.optional(), texts })
  .strict();

/** `PATCH …/:id` — at least one field; `texts` replaces every language. */
export const updateCategorySchema = z
  .object({ key: fields.key, sortOrder: fields.sortOrder, isActive: fields.isActive, texts })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, invalid);

export type CreateCategoryBody = CategoryInput;
export type UpdateCategoryBody = Partial<CategoryInput>;
