import { z } from 'zod';

/** The client polls the same token it was handed with the deep link. */
export const botLinkStatusSchema = z.object({
  linkToken: z.string().min(16).max(128),
});

export type BotLinkStatusInput = z.infer<typeof botLinkStatusSchema>;
