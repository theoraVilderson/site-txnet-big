import { BackendI18nKeys, type BackendI18nKeysKey } from '@txnet-backend/shared-core';

/** Any key a `BotText` may carry from the `bot` namespace. */
export type BotKey = `bot.${BackendI18nKeysKey<'bot'>}`;

type Prefixed<T, P extends string> = {
  readonly [K in keyof T]: T[K] extends string ? `${P}${T[K]}` : Prefixed<T[K], P>;
};

function prefixed<T extends object, P extends string>(tree: T, prefix: P): Prefixed<T, P> {
  return Object.fromEntries(
    Object.entries(tree).map(([k, v]) => [k, typeof v === 'string' ? `${prefix}${v}` : prefixed(v as object, prefix)]),
  ) as Prefixed<T, P>;
}

/**
 * The generated `bot` namespace as the keys a `BotText` carries (C-07).
 *
 * `BotCopy` routes on the key's first segment — `bot.*` to `bot.json`, anything
 * else to `notifications` — so a flow's key is `bot.action.cancel` while the
 * generated leaf is `action.cancel`. This adds the prefix once; the strings are
 * byte-identical to the literals they replace, and a key renamed in
 * `locales/backend` is now a compile error at the flow instead of a raw key in
 * the chat.
 */
export const BotKeys = prefixed(BackendI18nKeys.bot, 'bot.');

const BOT_LINK = BackendI18nKeys.notifications.otp.botLink;

/**
 * The `notifications` key for an `auth-api` link outcome's `messageKey`.
 *
 * `messageKey` arrives over HTTP as a string, so it is looked up in the
 * generated namespace rather than spliced into `` `otp.botLink.${k}` ``: a value
 * this build has no sentence for says "try again" instead of rendering a raw
 * key, and a key renamed in `notifications.json` stops compiling in
 * `auth-service`'s `BOT_LINK_MESSAGE_KEY` (C-07).
 */
export function botLinkMessageKey(messageKey: string): string {
  return Object.prototype.hasOwnProperty.call(BOT_LINK, messageKey)
    ? BOT_LINK[messageKey as keyof typeof BOT_LINK]
    : BotKeys.common.tryAgain;
}
