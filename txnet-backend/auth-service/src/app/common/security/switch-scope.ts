import { RequestHeaders } from '@txnet-backend/shared-core';
import { Request } from 'express';
import { isBotPlatform } from '@txnet-backend/messenger';
import { refreshCookieOptions } from '../http/refresh-cookie';
import { readCookie } from '../http/cookies';
import { BOT_CHAT_HEADER, isServiceCaller } from './service-caller';

/** Which messenger a bot-originated call is acting for. Name from the wire
 * contract, not a second spelling of it (C-04). */
export const BOT_PLATFORM_HEADER = RequestHeaders.botPlatform;

/** The browser's partition key. Server-minted, httpOnly, never read by script. */
export const DEVICE_COOKIE = 'device_id';

/**
 * A **switch scope**: the surface instance an account-switch group belongs to
 * (ADR-0015).
 *
 * A group is not a property of the person. It is a property of the place the
 * person built it — one Telegram chat, one browser — so three accounts wired
 * up inside a chat and two different ones in a browser stay strictly apart.
 * The key is what makes "this place" a value the database can hold:
 *
 *   `bot:telegram:12345`   one chat, on one platform
 *   `device:<uuid>`        one browser
 *
 * The platform is part of the bot key because a Telegram chat id and a Bale
 * chat id are integers from unrelated namespaces: without it, chat 12345 on
 * Telegram and chat 12345 on Bale would share a group.
 *
 * **It is a partition key, not a credential.** Forging a `device_id` from a
 * browser buys nothing — membership still has to exist under the key, and
 * membership is only ever written after an account proves itself (audit
 * invariant #4). That is why this is a cookie rather than something signed:
 * there is nothing here to protect.
 */
export type SwitchScope = string;

export function botScopeKey(platform: string, chatId: string): SwitchScope {
  return `bot:${platform}:${chatId}`;
}

export function deviceScopeKey(deviceId: string): SwitchScope {
  return `device:${deviceId}`;
}

/**
 * The `device_id` cookie, in the same shape as `refresh_token`.
 *
 * Domain-wide for the same reason (`common/http/refresh-cookie.ts`): the panel
 * is served from `panel.<domain>` and calls `api.<domain>`, so a host-only
 * cookie would be minted fresh on every call and every browser would look like
 * a new device forever.
 *
 * It outlives the refresh token on purpose. A session ends often — logging out
 * is normal — but the *browser* is the same browser afterwards, and its group
 * should still be there. A year is long enough that the group survives ordinary
 * use, and short enough that an abandoned key eventually lapses.
 */
export function deviceCookieOptions() {
  return {
    ...refreshCookieOptions(),
    maxAge: 365 * 24 * 60 * 60 * 1000,
  };
}

/**
 * The scope this request belongs to, or `null` when it has none.
 *
 * `null` is a real answer and never a reason to guess. A service caller that
 * sends a chat id but no platform is the case that matters: picking a default
 * platform there would silently merge Telegram's and Bale's groups, so the
 * scope-bearing routes answer `ok:false` instead.
 *
 * Set by `SwitchScopeMiddleware`, which is where a browser's cookie is minted.
 */
export function resolveSwitchScope(req: Request): SwitchScope | null {
  return (req as { switchScope?: SwitchScope | null }).switchScope ?? null;
}

/**
 * The scope of a call that has already been marked by `ServiceCallerMiddleware`
 * — pure, so the middleware and its spec share one definition of the rule.
 *
 * Returns `null` for a service caller whose headers do not name both a platform
 * and a chat. Browser scope is not decided here: it needs a cookie that may
 * have to be minted, which is a side effect and belongs in the middleware.
 */
export function botScopeOf(req: Request): SwitchScope | null {
  if (!isServiceCaller(req)) return null;

  const platform = req.headers[BOT_PLATFORM_HEADER];
  const chatId = req.headers[BOT_CHAT_HEADER];
  if (typeof platform !== 'string' || typeof chatId !== 'string') return null;
  if (!chatId || !isBotPlatform(platform)) return null;

  return botScopeKey(platform, chatId);
}
