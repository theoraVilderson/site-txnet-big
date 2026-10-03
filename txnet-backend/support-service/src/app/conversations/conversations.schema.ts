import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { PAGE_MAX } from './conversations.service';

const invalid = BackendI18nKeys.errors.validation.failed;

/** A message body: catalog §11.2's whole flow is "type". Long enough for a log paste, short enough to page. */
export const MESSAGE_BODY_MAX = 4000;

const body = z.string().trim().min(1, invalid).max(MESSAGE_BODY_MAX, invalid);
const seq = z.coerce.number().int().min(0, invalid);

/** `POST /api/support/conversations` — a category is optional, a subject is derived when absent. */
export const openSchema = z
  .object({
    body,
    subject: z.string().trim().min(1, invalid).max(120, invalid).optional(),
    categoryId: z.string().uuid(invalid).optional(),
  })
  .strict();

/** `POST /api/support/conversations/:id/messages`. */
export const sendSchema = z.object({ body }).strict();

/** `POST /api/support/conversations/:id/attachments` — the multipart text field; files arrive beside it. */
export const attachSchema = z
  .object({ body: z.string().trim().max(MESSAGE_BODY_MAX, invalid).optional() })
  .strict()
  .optional();

/** `POST /api/support/conversations/:id/read` — no `upToSeq` (or no body at all) reads to the end. */
export const readSchema = z.object({ upToSeq: seq.optional() }).strict().optional();

/** `GET /api/support/conversations?before=&limit=` — `before` is the previous page's `nextBefore`. */
export const listQuerySchema = z
  .object({
    before: z.coerce.date({ message: invalid }).optional(),
    limit: z.coerce.number().int().min(1, invalid).max(PAGE_MAX, invalid).optional(),
  })
  .strict();

/** `GET /api/support/conversations/:id/messages?afterSeq=|beforeSeq=&limit=`. */
export const messagesQuerySchema = z
  .object({
    afterSeq: seq.optional(),
    beforeSeq: seq.optional(),
    limit: z.coerce.number().int().min(1, invalid).max(PAGE_MAX, invalid).optional(),
  })
  .strict()
  .refine((q) => q.afterSeq === undefined || q.beforeSeq === undefined, { message: invalid });

/** `body` is required; a subject and a category are optional on purpose (zod infers all optional here, no strictNullChecks). */
export type OpenBody = z.infer<typeof openSchema> & { body: string };
export type SendBody = Required<z.infer<typeof sendSchema>>;
export type ReadBody = z.infer<typeof readSchema>;
export type AttachBody = z.infer<typeof attachSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
export type MessagesQuery = z.infer<typeof messagesQuerySchema>;
