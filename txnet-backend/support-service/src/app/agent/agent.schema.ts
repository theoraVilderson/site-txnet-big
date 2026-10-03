import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { MESSAGE_BODY_MAX } from '../conversations/conversations.schema';
import { PAGE_MAX } from '../conversations/conversations.service';
import { INBOX_VIEWS } from './agent.service';

const invalid = BackendI18nKeys.errors.validation.failed;

/** `GET /api/support/agent/conversations?view=&after=&limit=` — `after` is the previous page's `nextAfter`. */
export const inboxQuerySchema = z
  .object({
    view: z.enum(INBOX_VIEWS, { message: invalid }).optional(),
    after: z.string().uuid(invalid).optional(),
    limit: z.coerce.number().int().min(1, invalid).max(PAGE_MAX, invalid).optional(),
  })
  .strict();

/** `POST /api/support/agent/conversations/:id/messages` — `internal: true` is a note the user never sees. */
export const replySchema = z
  .object({
    body: z.string().trim().min(1, invalid).max(MESSAGE_BODY_MAX, invalid),
    internal: z.boolean({ message: invalid }).optional(),
  })
  .strict();

/** `POST /api/support/agent/conversations/:id/assign` — `null` puts it back in the queue. */
export const assignSchema = z.object({ assigneeUserId: z.string().uuid(invalid).nullable() }).strict();

export type InboxQuery = z.infer<typeof inboxQuerySchema>;
export type ReplyBody = z.infer<typeof replySchema> & { body: string };
export type AssignBody = { assigneeUserId: string | null };
