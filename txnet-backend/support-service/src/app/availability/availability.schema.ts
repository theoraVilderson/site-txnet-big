import { ConversationPriority } from '@prisma/client';
import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { HOURS_MAX_INTERVALS, PRESENCE_STATUSES } from './availability';

const invalid = BackendI18nKeys.errors.validation.failed;

const START = /^([01]\d|2[0-3]):[0-5]\d$/;
const END = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/** `POST /api/support/agent/presence` — every 30s while the panel is open, `away` on leaving. */
export const presenceSchema = z.object({ status: z.enum(PRESENCE_STATUSES, { message: invalid }) }).strict();

/** `PUT /api/support/settings/hours` — the whole week; `[]` is always open. Overlaps are the service's to refuse. */
export const hoursSchema = z
  .object({
    intervals: z
      .array(
        z
          .object({
            weekday: z.number().int().min(0, invalid).max(6, invalid),
            start: z.string().regex(START, invalid),
            end: z.string().regex(END, invalid),
          })
          .strict(),
      )
      .max(HOURS_MAX_INTERVALS, invalid),
  })
  .strict();

/** `PUT /api/support/settings/sla` — the tenant's own targets; a priority left out is the platform's. Limits are the service's. */
export const slaSchema = z
  .object({
    targets: z
      .array(
        z
          .object({
            priority: z.nativeEnum(ConversationPriority, { message: invalid }),
            firstResponseMinutes: z.number().int(invalid),
            resolutionMinutes: z.number().int(invalid),
          })
          .strict(),
      )
      .max(Object.keys(ConversationPriority).length, invalid),
  })
  .strict();

export type SlaBody = { targets: { priority: ConversationPriority; firstResponseMinutes: number; resolutionMinutes: number }[] };
export type PresenceBody = { status: (typeof PRESENCE_STATUSES)[number] };
export type HoursBody = { intervals: { weekday: number; start: string; end: string }[] };
