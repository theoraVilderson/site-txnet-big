import { Language } from '@prisma/client';
import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { CANNED_BODY_MAX, CANNED_KEY, CannedInput } from './canned';

const invalid = BackendI18nKeys.errors.validation.failed;

const texts = z
  .array(
    z
      .object({
        lang: z.nativeEnum(Language, { message: invalid }),
        body: z.string().trim().min(1, invalid).max(CANNED_BODY_MAX, invalid),
      })
      .strict(),
  )
  .max(Object.keys(Language).length, invalid);

const fields = {
  key: z.string().regex(CANNED_KEY, invalid),
  sortOrder: z.number().int(invalid).min(0, invalid).max(10_000, invalid),
  isActive: z.boolean({ message: invalid }),
  texts,
};

/** `POST /api/support/settings/canned-replies`. Empty `texts`, a language twice or an unknown variable are the service's to refuse. */
export const createCannedSchema = z
  .object({ key: fields.key, sortOrder: fields.sortOrder.optional(), isActive: fields.isActive.optional(), texts })
  .strict();

/** `PATCH …/:id` — at least one field; `texts` replaces every language. */
export const updateCannedSchema = z
  .object({ key: fields.key, sortOrder: fields.sortOrder, isActive: fields.isActive, texts })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, invalid);

export type CreateCannedBody = CannedInput;
export type UpdateCannedBody = Partial<CannedInput>;
