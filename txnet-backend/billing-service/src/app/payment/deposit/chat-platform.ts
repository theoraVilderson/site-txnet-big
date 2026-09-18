/** The messengers an in-chat driver can name (`PaymentProvider.chatPlatform`). */
export const CHAT_PLATFORMS = ['telegram', 'bale'] as const;

/** What `DepositController` read off the request, already checked for the service token. */
export interface ChatCaller {
  /** The service token checked out: this is `bot-service`, not a browser. */
  isBot: boolean;
  /** `X-Bot-Platform` — believed only when `isBot`. */
  botPlatform: string | null;
  /** `X-Bot-Tenant-Id`, the tenant of the bot the update arrived at — believed only when `isBot`. */
  botTenantId: string | null;
  /** The gate's `X-Chat-Platform`, from a Mini App session a verified `initData` minted (F-104-q). */
  gatePlatform: string | null;
  /** The request's tenant — the payment's. */
  tenantId: string;
}

/**
 * The messenger this caller is in, or `null`: an in-chat gateway is offered
 * only there (F-104-k). The bot says so with `X-Bot-Platform` beside a
 * verified service token; a Mini App cannot, the gate says it (F-104-q).
 *
 * **A bot counts only for its own tenant's payments (F-061-j).** Its invoice
 * is paid to that bot, so a payment of another tenant — the owner topping up
 * their platform wallet from their reseller's bot chat (ADR-0059 (6)) — would
 * put the Stars in the reseller's bot and the credit in the platform's wallet.
 * An invoice made by the payment tenant's bot instead reports its events to a
 * bot where this chat holds no session, so the gateway is simply not offered.
 */
export function chatPlatformOf(caller: ChatCaller): string | null {
  const platform = caller.isBot
    ? caller.botTenantId === caller.tenantId
      ? caller.botPlatform
      : null
    : caller.gatePlatform;
  return platform && (CHAT_PLATFORMS as readonly string[]).includes(platform) ? platform : null;
}
