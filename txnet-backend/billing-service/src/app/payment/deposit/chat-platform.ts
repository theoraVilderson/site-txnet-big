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
  /** The gate's `X-Chat-Platform`, from a chat session — the bot's or a Mini App's a verified `initData` minted (F-104-q). */
  gatePlatform: string | null;
  /** The gate's `X-Chat-User-Id`, that session's chat id — a private chat's is the person's messenger id (F-104-ab). */
  gateChatId: string | null;
  /** The request's tenant — the payment's. */
  tenantId: string;
}

/** The messenger this caller is in, and the id its events will come from. */
export interface Chat {
  platform: string;
  /** Recorded on an in-chat payment as its payer's; the relay is admitted only from it (F-104-ab). */
  payerId: string;
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
 * Paying there through the payment tenant's bot is F-104-ac's.
 *
 * **And only with a payer the gate named in that messenger (F-104-ab).** The
 * platform's events are matched to the payment by the sender's messenger id,
 * which only the gate can vouch for — from the session's own chat scope. A
 * chat session that names none, or another messenger's, could never be matched,
 * so its gateway is not offered rather than refused at pre-checkout.
 */
export function chatOf(caller: ChatCaller): Chat | null {
  const platform = caller.isBot
    ? caller.botTenantId === caller.tenantId
      ? caller.botPlatform
      : null
    : caller.gatePlatform;
  if (!platform || !(CHAT_PLATFORMS as readonly string[]).includes(platform)) return null;
  if (caller.gatePlatform !== platform || !caller.gateChatId) return null;
  return { platform, payerId: caller.gateChatId };
}
