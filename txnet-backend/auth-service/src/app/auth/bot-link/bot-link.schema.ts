import { z } from 'zod';

/** The client polls the same token it was handed with the deep link. */
export const botLinkStatusSchema = z.object({
  linkToken: z.string().min(16).max(128),
});

export type BotLinkStatusInput = z.infer<typeof botLinkStatusSchema>;

/**
 * `bot-service` handing over the two updates that belong to the link flow. It
 * has already resolved the webhook secret and normalized the update; what it
 * cannot do is decide, because the contact rule behind invariant #12 lives in
 * `identity` and may exist only once (ADR-0011).
 */
export const botLinkResolveSchema = z.object({
  platform: z.enum(['telegram', 'bale']),
  chatId: z.string().min(1).max(64),
  /** The `?start=` payload. Absent means a bare `/start`. */
  startToken: z.string().min(1).max(128).optional(),
  languageCode: z.string().min(2).max(16).optional(),
});

/**
 * Signing in as the messenger account itself (ADR-0012). The contact card is
 * optional: a chat that has already proven itself needs nothing but its id,
 * and one that has not is told to send it.
 */
export const botSessionSchema = z.object({
  platform: z.enum(['telegram', 'bale']),
  chatId: z.string().min(1).max(64),
  senderId: z.union([z.string().min(1).max(64), z.number()]).optional(),
  contact: z
    .object({
      phone_number: z.string().min(3).max(32),
      user_id: z.union([z.string().min(1).max(64), z.number()]).optional(),
      first_name: z.string().max(128).optional(),
      last_name: z.string().max(128).optional(),
    })
    .optional(),
});

export type BotSessionInput = z.infer<typeof botSessionSchema>;

export const botLinkContactSchema = z.object({
  platform: z.enum(['telegram', 'bale']),
  chatId: z.string().min(1).max(64),
  /** `message.from.id` — the sender the contact card is compared against. */
  senderId: z.union([z.string().min(1).max(64), z.number()]),
  contact: z.object({
    phone_number: z.string().min(3).max(32),
    first_name: z.string().max(128).optional(),
    user_id: z.union([z.string().min(1).max(64), z.number()]).optional(),
  }),
});

export type BotLinkResolveInput = z.infer<typeof botLinkResolveSchema>;
export type BotLinkContactInput = z.infer<typeof botLinkContactSchema>;
