import { BOT_PLATFORMS } from '@txnet-backend/messenger';
import { z } from 'zod';

/**
 * The connect form's body (F-066-w5): which messenger, and the token.
 *
 * **The `@handle` is not here** and cannot be sent. It comes from the messenger
 * itself (`getMe`) after the token is proved, because a handle the reseller
 * typed would file the row under a name no deep link resolves to — and the
 * handle is half of `(tenantId, platform, botUsername)`.
 *
 * `.strict()` for the reason every reseller-named surface uses it: the tenant
 * is the path's, so a body carrying a `tenantId` is refused rather than
 * ignored. `role` is refused the same way — every bot connected here is the
 * `primary` (C-05), and F-315's other roles have no surface yet.
 *
 * The platform union is derived from `BOT_PLATFORMS` (C-09), so a third
 * messenger is accepted here the moment `messenger` knows about it. Nothing
 * about the token's *shape* is checked beyond being non-empty: both platforms
 * have changed their format, and the only judge that cannot go stale is the
 * platform's own answer.
 */
export const connectBotSchema = z
  .object({
    platform: z.enum(BOT_PLATFORMS as [string, ...string[]]),
    token: z.string().trim().min(1).max(200),
  })
  .strict();

export type ConnectBotBody = z.infer<typeof connectBotSchema>;
