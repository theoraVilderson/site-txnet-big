import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const invalid = BackendI18nKeys.errors.validation.failed;

/** `POST /api/currency/pins` (F-0608-a). The rate is a decimal string (C-02). */
export const pinSchema = z
  .object({
    code: z.string().regex(/^[A-Z]{3}$/, invalid),
    rate: z.string().regex(/^\d{1,10}(\.\d{1,18})?$/, invalid),
    reason: z.string().trim().min(3, invalid).max(500, invalid),
    /** One hour to thirty days, or `null`: no end, until a person ends it (F-116-n). */
    hours: z.number().int().min(1, invalid).max(720, invalid).nullable(),
  })
  .strict();

/** `Required`: this workspace compiles without strictNullChecks, where zod infers every key optional. */
export type PinBody = Required<z.infer<typeof pinSchema>>;
