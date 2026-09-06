import { BotPlatform } from './bot-platform';

/**
 * What a platform can do (`F-301`).
 *
 * **A flag is a claim about a vendor API, and a claim carries the date it was
 * verified.** `verifiedOn` is not decoration: an undated flag is a guess that
 * outlived the person who made it, and the failure it causes ("works on
 * Telegram, silently wrong on Bale") surfaces in production, not in a test.
 * Re-read both vendors' docs before adding an axis, and move the date in the
 * same change — see `docs/platform/messenger/contract.md`.
 */
export interface MessengerCapabilities {
  /** ISO date on which every axis below was last read from the vendor's docs. */
  readonly verifiedOn: string;
  /** Where those docs are, so the next reader verifies the same source. */
  readonly source: string;

  readonly inlineKeyboard: boolean;
  readonly replyKeyboard: boolean;
  /** A reply-keyboard button that returns the sender's own contact card. */
  readonly requestContact: boolean;
  /**
   * The bot may delete a message the *user* sent in a private chat. This is
   * what makes typing a password in chat survivable (ADR-0011, decision 3).
   */
  readonly deleteIncomingMessage: boolean;
  /** How long after sending a message it can still be deleted. */
  readonly deleteWindowSeconds: number;
  readonly webApp: boolean;
  /** The global the Mini App reads on this platform. */
  readonly webAppGlobal: string;
  /** In-chat payment rails. The one axis where the platforms truly diverge. */
  readonly payment: 'provider-tokens' | 'wallet' | 'none';

  readonly photoUploadBytes: number;
  readonly documentUploadBytes: number;
}

const MB = 1024 * 1024;

/**
 * Verified 2026-09-06 against the two vendors' own documentation.
 *
 * The catalog's premise (§10.3, "Bale is a subset of Telegram") does not hold:
 * on presence of capability the two are identical, including the 48-hour
 * incoming-message delete window. Every real divergence is a difference of
 * *shape* — base URL, deep link, WebApp global, payment rails — which is why
 * this table is short and the shape adapters (`deep-link.ts`, the registry's
 * API base) are where the risk actually lives. See ADR-0009's amendment.
 */
export const MESSENGER_CAPABILITIES: Record<BotPlatform, MessengerCapabilities> =
  {
    telegram: {
      verifiedOn: '2026-09-06',
      source: 'https://core.telegram.org/bots/api',
      inlineKeyboard: true,
      replyKeyboard: true,
      requestContact: true,
      // "Bots can delete incoming messages in private chats." +
      // "A message can only be deleted if it was sent less than 48 hours ago."
      deleteIncomingMessage: true,
      deleteWindowSeconds: 48 * 3600,
      webApp: true,
      webAppGlobal: 'Telegram.WebApp',
      payment: 'provider-tokens',
      photoUploadBytes: 10 * MB,
      documentUploadBytes: 50 * MB,
    },
    bale: {
      verifiedOn: '2026-09-06',
      source: 'https://docs.bale.ai/',
      inlineKeyboard: true,
      replyKeyboard: true,
      requestContact: true,
      // "بازوها می‌توانند پیام‌های ورودی را در گفتگو‌های خصوصی حذف کنند" +
      // "کمتر از ۴۸ ساعت قبل ارسال شده باشد" — the same rule, same window.
      deleteIncomingMessage: true,
      deleteWindowSeconds: 48 * 3600,
      webApp: true,
      webAppGlobal: 'Bale.WebApp',
      payment: 'wallet',
      photoUploadBytes: 10 * MB,
      documentUploadBytes: 50 * MB,
    },
  };

export function capabilitiesOf(platform: BotPlatform): MessengerCapabilities {
  return MESSENGER_CAPABILITIES[platform];
}
