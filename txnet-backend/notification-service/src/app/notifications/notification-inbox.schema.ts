import { NotificationType } from '@prisma/client';
import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * The inbox's wire shapes (F-035-a). Every refusal is the one generic
 * `validation.failed` key: none of these fields is typed by a person, so a bad
 * value is a caller's bug and a field-level sentence would be read by nobody.
 */
const invalid = BackendI18nKeys.errors.validation.failed;

/** Paging names no default — the service does, for the reason `billing-service`'s `wallet-history.schema.ts` gives. */
export const inboxQuerySchema = z.object({
  page: z.coerce.number({ message: invalid }).int({ message: invalid }).positive({ message: invalid }).optional(),
  pageSize: z.coerce.number({ message: invalid }).int({ message: invalid }).positive({ message: invalid }).max(100, { message: invalid }).optional(),
  /** A query string carries text: only `true` and `false` mean anything, and anything else is refused. */
  unreadOnly: z
    .preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean({ message: invalid }))
    .optional(),
});

/** Absent `ids` is "mark all"; an empty list is refused, because it would mean nothing and look like "all". */
export const markReadSchema = z.object({
  ids: z.array(z.string().uuid({ message: invalid }), { message: invalid }).min(1, { message: invalid }).max(100, { message: invalid }).optional(),
});

/** The internal seam's body. Plain text: a caller renders the user's language before it asks. */
export const createNotificationSchema = z.object({
  userId: z.string({ message: invalid }).uuid({ message: invalid }),
  type: z.nativeEnum(NotificationType, { message: invalid }),
  title: z.string({ message: invalid }).min(1, { message: invalid }).max(200, { message: invalid }),
  body: z.string({ message: invalid }).min(1, { message: invalid }).max(2000, { message: invalid }),
});

export type InboxQuery = z.infer<typeof inboxQuerySchema>;
export type MarkReadBody = z.infer<typeof markReadSchema>;
