// The bot chat families, split out of keys.ts by job (C-20); shared-core's index re-exports both.

/**
 * Every chat key names its integration, not just its platform (F-320).
 *
 * A chat id is issued by the messenger, not by the bot: the same person talking
 * to two tenants' Telegram bots is the same `chatId` on both. Keyed by platform
 * alone, one reseller's customer would resume the other reseller's conversation
 * and — for `bot:session:` — hold the other reseller's refresh token. The
 * integration id is the one door the update came through (ADR-0009), so it is
 * what separates them. The platform stays ahead of it because it costs nothing
 * and keeps the keyspace scannable per messenger.
 *
 * Typed structurally rather than against `BotIntegration` so this library does
 * not depend on `messenger`; `bot-service` passes the real type straight in.
 */
export interface BotKeyIntegration {
  readonly platform: string;
  readonly id: string;
}

const chatScope = (integration: BotKeyIntegration, chatId: string) =>
  `${integration.platform}:${integration.id}:${chatId}`;

/** The bot chat families. No ambient scope: the integration is the scope. */
export const BotRedisKeys = {
  /**
   * Navigation state: which screen the chat is on, what it has typed so far,
   * where "back" goes. Losing it costs the user one tap, which is exactly why
   * it lives here and a commitment does not (ADR-0010).
   */
  botNav: (integration: BotKeyIntegration, chatId: string) =>
    `bot:nav:${chatScope(integration, chatId)}`,
  /**
   * A signed-in chat: the `auth-api` refresh token and who it belongs to. This
   * entry — never the chat id on its own — is what makes a chat authenticated
   * (`bot-app/contract.md`).
   */
  botSession: (integration: BotKeyIntegration, chatId: string) =>
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
   * not, so a preference carried across would be a choice the second bot cannot
   * honour and the user never made there.
   */
  botLang: (integration: BotKeyIntegration, chatId: string) =>
    `bot:lang:${chatScope(integration, chatId)}`,
  /**
   * The platform's own id for a guide file this bot already sent (F-414-f):
   * sent again by id, a 30 MB video is not uploaded on every tap. Per bot,
   * because a `file_id` is good only on the bot that received it; the object
   * key never changes for the same bytes (ADR-0118 point 4).
   */
  botGuideFile: (integration: BotKeyIntegration, objectKey: string) =>
    `bot:guidefile:${integration.platform}:${integration.id}:${objectKey}`,
  /**
   * This chat was told its queued updates were too old to run (hosting H19).
   * Set NX, so a backlog of stale messages from one chat is answered once.
   */
  botStaleNotice: (integration: BotKeyIntegration, chatId: string) =>
    `bot:stale-notice:${chatScope(integration, chatId)}`,
} as const;
