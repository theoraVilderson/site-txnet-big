import { BotIntegration } from '@txnet-backend/messenger';

/**
 * Every Redis key `bot-service` uses is built here — nothing else hand-writes
 * a key string (C-03). ioredis prepends
 * `${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:`, so a nav key is
 * `txnet:auth:v1:bot:nav:telegram:<integrationId>:<chatId>` on the wire, in the
 * same keyspace auth-service writes.
 *
 * **Every chat key names its integration, not just its platform** (F-320).
 * A chat id is issued by the messenger, not by the bot: the same person
 * talking to two tenants' Telegram bots is the same `chatId` on both. Keyed by
 * platform alone, one reseller's customer would resume the other reseller's
 * conversation and — for `bot:session:` — hold the other reseller's refresh
 * token. The integration id is the one door the update came through (ADR-0009),
 * so it is what separates them. The platform stays in the key ahead of it
 * because it costs nothing and keeps the keyspace scannable per messenger.
 */
const chatScope = (integration: BotIntegration, chatId: string) =>
  `${integration.platform}:${integration.id}:${chatId}`;

export const RedisKeys = {
  /**
   * Navigation state: which screen the chat is on, what it has typed so far,
   * where "back" goes. Losing it costs the user one tap, which is exactly why
   * it lives here and a commitment does not (ADR-0010).
   */
  botNav: (integration: BotIntegration, chatId: string) =>
    `bot:nav:${chatScope(integration, chatId)}`,
  /**
   * A signed-in chat: the `auth-api` refresh token and who it belongs to.
   * This entry — never the chat id on its own — is what makes a chat
   * authenticated (`bot-app/contract.md`).
   */
  botSession: (integration: BotIntegration, chatId: string) =>
    `bot:session:${chatScope(integration, chatId)}`,
  /**
   * The language this chat asked for, by hand.
   *
   * Deliberately not part of the session or the navigation state: it outlives
   * both. A preference that expires with the conversation that set it is a
   * preference the user has to set again every time, which is worse than not
   * offering the choice.
   *
   * Scoped to the integration like the other two, even though a language is
   * harmless to share: one tenant's bot may serve a language another's does
   * not, so a preference carried across would be a choice the second bot
   * cannot honour and the user never made there.
   */
  botLang: (integration: BotIntegration, chatId: string) =>
    `bot:lang:${chatScope(integration, chatId)}`,
} as const;

/** Canonical TTLs (seconds); the env can widen them, not scatter them. */
export const RedisTtl = {
  botNav: 30 * 60,
  botSession: 30 * 24 * 3600,
  // Long: this is a preference, not a session. It is re-armed on every use.
  botLang: 180 * 24 * 3600,
} as const;
