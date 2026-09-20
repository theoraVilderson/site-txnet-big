import type { BotPlatformName, ResellerBot } from "@/lib/auth-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The screen's strings as generated constants (C-06). */
export const BOT_KEYS = FrontendI18nKeys.common.resellerBots;
const K = BOT_KEYS;

/**
 * Every reason `/api/auth/tenants/:tenantId/bots` refuses with — both doors:
 * shared-core's `ResellerAccessRejection` (who may configure this reseller,
 * invariant 21) and `ResellerBotService`'s own (what may be done to its bots).
 * The spec reads the union from the controller's exhaustive `STATUS` map, so a
 * reason added there has no sentence here until one is written.
 */
export type BotRefusal =
  | "not_allowed"
  | "reseller_not_found"
  | "reseller_suspended"
  | "reseller_terminated"
  | "invalid_token"
  | "bot_already_connected"
  | "primary_exists"
  | "bot_not_found"
  | "vault_unavailable";

export const BOT_REFUSAL_KEYS: Record<BotRefusal, string> = K.refusals;

/** The refusal's own sentence key, when the service named one this screen knows. */
export function botRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in BOT_REFUSAL_KEYS ? BOT_REFUSAL_KEYS[reason as BotRefusal] : null;
}

/**
 * The messengers the form offers, mirroring `messenger`'s `BOT_PLATFORMS`
 * (C-09) — the service derives its own enum from that list, and the spec holds
 * the two together, so a third messenger is one line here.
 */
export const BOT_PLATFORMS = ["telegram", "bale"] as const satisfies readonly BotPlatformName[];

export const PLATFORM_KEYS: Record<BotPlatformName, string> = K.platforms;
export const BOT_STATUS_KEYS: Record<ResellerBot["status"], string> = K.status;
export const BOT_STATUS_HINT_KEYS: Record<ResellerBot["status"], string> = K.statusHint;
export const BOT_ROLE_KEYS: Record<ResellerBot["role"], string> = K.roles;
/** Where the token comes from, per messenger — a reseller who has never made a bot needs this first. */
export const BOT_HINT_KEYS: Record<BotPlatformName, string> = K.hint;

/**
 * The token to send, or `null` where `connectBotSchema` would refuse it:
 * 1-200 characters after a trim, and **nothing about its shape**. Both
 * messengers have changed their token format; the only judge that cannot go
 * stale is the messenger's own answer, which arrives as `invalid_token`.
 */
export function botToken(raw: string): string | null {
  const token = raw.trim();
  return token.length >= 1 && token.length <= 200 ? token : null;
}

/**
 * The connect body, exactly: the schema is `.strict()`, so a `tenantId` the
 * session could supply or a `role` is refused rather than ignored — the tenant
 * is the path's, and every bot connected here is the `primary` (C-05). The
 * `@handle` is never sent either: it comes from `getMe`, because a typed one
 * would file the row under a name no deep link resolves to.
 */
export function connectBody(platform: BotPlatformName, token: string): { platform: BotPlatformName; token: string } {
  return { platform, token: token.trim() };
}

/**
 * Whether this messenger already has this reseller's bot. A second one is
 * `primary_exists`, never a silent demotion — so the form says so before the
 * call rather than after it.
 */
export const isPrimaryTaken = (bots: readonly ResellerBot[], platform: BotPlatformName) =>
  bots.some((b) => b.platform === platform);
