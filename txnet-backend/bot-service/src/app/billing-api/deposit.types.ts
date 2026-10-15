import { BotPlatform } from '@txnet-backend/messenger';
import type { DepositTransfer } from './transfer.types';

/** One gateway as `GET /api/billing/deposit/gateways` lists it (`billing/contract.deposit.md`). */
export interface DepositGateway {
  id: string;
  source: 'tenant' | 'platform';
  displayName: string;
  providerName: string;
  category: string;
  minAmount: string | null;
  maxAmount: string | null;
  /** The gateway's quick amounts (F-092-v); empty = none to offer. */
  presets: string[];
  /** What the limits and presets are in (F-116-h2); the payment's currency, since only those are listed. */
  currencyCode: string;
}

/** The quote's and the start's body — the same body, on purpose (F-0612). */
export interface DepositBody {
  gatewayId: string;
  source: 'tenant' | 'platform';
  /** In the gateway's `currencyCode`, a decimal string — billing validates it. */
  amount: string;
}

/** Money as decimal strings, exactly as billing answered. The bot does no arithmetic. */
export interface DepositQuote {
  amount: string;
  discount: string;
  fee: string;
  /** Added on top of the fee (ADR-0076); `"0.00"` when the top-up is not taxed. */
  tax: string;
  /** The rate `tax` was charged at; `null` = no tax. */
  taxRatePercent: string | null;
  payable: string;
  credited: string;
  free: boolean;
  /** What every figure above is in (F-116-h2) — shown beside each one (F-116-h4). */
  currencyCode: string;
}

export interface DepositStarted extends DepositQuote {
  paymentId: string;
  /** The gateway's own page; `null` on a fully discounted top-up. */
  redirectUrl: string | null;
  /** The new balance, on the free path only. */
  balance: string | null;
  /**
   * What the chat's invoice carries, for a gateway paid inside the chat (F-104-k):
   * the payload comes back with the payment's events, `amountMinor` is whole
   * units of `currency` (Stars, rials), `providerToken` the gateway's own (Bale's
   * wallet, F-104-n) or `null`. `null` for every other gateway.
   */
  invoice: { payload: string; currency: string; amountMinor: string; providerToken: string | null } | null;
  /** A manual gateway's destination and proof (F-803-d); absent from an older billing, null for any other gateway. */
  transfer?: DepositTransfer | null;
}

/**
 * A messenger's payment event as billing takes it back (F-104-k); the amount as
 * a string. The sender and this bot's tenant are what billing matches the
 * payment's payer on (F-104-ab) — no chat session is involved.
 */
export interface InChatPaymentBody {
  paymentId: string;
  currency: string;
  totalAmount: string;
  platform: BotPlatform;
  /** The messenger id of whoever the platform says is paying. */
  senderId: string;
  /** The tenant of the bot the event arrived at. */
  botTenantId: string;
}

export type PreCheckoutVerdict = { approved: true } | { approved: false; reason: 'not_found' | 'not_payable' | 'amount_mismatch' };

export interface InChatPaid {
  status: 'credited' | 'already_settled' | 'unsettled' | 'not_found';
  credited: string | null;
  /** The payment's currency, what `credited` is in (F-116-h4); absent from an older billing. */
  currencyCode?: string | null;
}
