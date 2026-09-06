/**
 * Every Redis key `bot-service` uses is built here — nothing else hand-writes
 * a key string (C-03). ioredis prepends
 * `${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:`, so `botNav('telegram','5')`
 * is `txnet:auth:v1:bot:nav:telegram:5` on the wire, in the same keyspace
 * auth-service writes.
 */
export const RedisKeys = {
  /**
   * Navigation state: which screen the chat is on, what it has typed so far,
   * where "back" goes. Losing it costs the user one tap, which is exactly why
   * it lives here and a commitment does not (ADR-0010).
   */
  botNav: (platform: string, chatId: string) => `bot:nav:${platform}:${chatId}`,
  /**
   * A signed-in chat: the `auth-api` refresh token and who it belongs to.
   * This entry — never the chat id on its own — is what makes a chat
   * authenticated (`bot-app/contract.md`).
   */
  botSession: (platform: string, chatId: string) =>
    `bot:session:${platform}:${chatId}`,
  /**
   * The language this chat asked for, by hand.
   *
   * Deliberately not part of the session or the navigation state: it outlives
   * both. A preference that expires with the conversation that set it is a
   * preference the user has to set again every time, which is worse than not
   * offering the choice.
   */
  botLang: (platform: string, chatId: string) =>
    `bot:lang:${platform}:${chatId}`,
} as const;

/** Canonical TTLs (seconds); the env can widen them, not scatter them. */
export const RedisTtl = {
  botNav: 30 * 60,
  botSession: 30 * 24 * 3600,
  // Long: this is a preference, not a session. It is re-armed on every use.
  botLang: 180 * 24 * 3600,
} as const;
