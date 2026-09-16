import { BotPlatform } from './bot-platform';
import { capabilitiesOf } from './capabilities';
import type { BotUpdate } from './update.types';

/**
 * The in-chat invoice rail (F-104-l, D-32): one invoice shape and one pair of
 * events for every platform, following each platform's `payment` capability.
 *
 * Read 2026-09-16 from core.telegram.org/bots/api#payments and docs.bale.ai:
 * - Telegram (`provider-tokens`) names a `currency`. Telegram Stars (`XTR`)
 *   take no provider token and exactly one price; any other currency needs one.
 * - Bale (`wallet`) prices in Rials, has **no** `currency` parameter, and always
 *   needs the wallet's `provider_token`.
 * - Both: title 1-32 chars, description 1-255 chars, payload 1-128 bytes; the
 *   `pre_checkout_query` and `successful_payment` objects use the same field
 *   names, so the events below are parsed once.
 *
 * Nothing above this unit reads the difference: a caller describes an invoice,
 * and a refusal names what was wrong rather than the platform.
 */

export const STARS_CURRENCY = 'XTR';
export const BALE_WALLET_CURRENCY = 'IRR';

export interface InvoicePrice {
  label: string;
  /** Whole units of `currency`'s smallest unit: Stars, Rials, cents. */
  amount: number;
}

export interface Invoice {
  title: string;
  description: string;
  /** Returned verbatim in both events — the only link back to the payment. */
  payload: string;
  currency: string;
  prices: InvoicePrice[];
  /** The platform's payment provider token. Never logged. */
  providerToken?: string;
}

export type InvoiceRefusal =
  | 'payment_unsupported'
  | 'currency_unsupported'
  | 'provider_token_required'
  | 'provider_token_forbidden'
  | 'invalid_field'
  | 'invalid_prices';

export type InvoiceParamsResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; reason: InvoiceRefusal };

const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');
const within = (s: string, max: number) => s.length >= 1 && s.length <= max;

/** The platform's own `sendInvoice` / `createInvoiceLink` fields, or why not. */
export function invoiceParams(
  platform: BotPlatform,
  invoice: Invoice,
): InvoiceParamsResult {
  const { title, description, payload, currency, prices, providerToken } =
    invoice;
  if (
    !within(title, 32) ||
    !within(description, 255) ||
    byteLength(payload) < 1 ||
    byteLength(payload) > 128
  ) {
    return { ok: false, reason: 'invalid_field' };
  }
  if (
    !prices.length ||
    prices.some((p) => !Number.isInteger(p.amount) || p.amount <= 0 || !p.label)
  ) {
    return { ok: false, reason: 'invalid_prices' };
  }
  const base = { title, description, payload };
  const wirePrices = prices.map(({ label, amount }) => ({ label, amount }));

  switch (capabilitiesOf(platform).payment) {
    case 'provider-tokens':
      if (currency === STARS_CURRENCY) {
        if (providerToken) return { ok: false, reason: 'provider_token_forbidden' };
        if (prices.length !== 1) return { ok: false, reason: 'invalid_prices' };
        return { ok: true, params: { ...base, currency, prices: wirePrices } };
      }
      if (!/^[A-Z]{3}$/.test(currency)) {
        return { ok: false, reason: 'currency_unsupported' };
      }
      if (!providerToken) return { ok: false, reason: 'provider_token_required' };
      return {
        ok: true,
        params: { ...base, provider_token: providerToken, currency, prices: wirePrices },
      };
    case 'wallet':
      if (currency !== BALE_WALLET_CURRENCY) {
        return { ok: false, reason: 'currency_unsupported' };
      }
      if (!providerToken) return { ok: false, reason: 'provider_token_required' };
      return {
        ok: true,
        params: { ...base, provider_token: providerToken, prices: wirePrices },
      };
    case 'none':
      return { ok: false, reason: 'payment_unsupported' };
  }
}

/** The payer confirmed; the bot must answer within 10 seconds on both platforms. */
export interface PreCheckoutEvent {
  kind: 'pre_checkout';
  queryId: string;
  fromId: string;
  currency: string;
  totalAmount: number;
  payload: string;
}

/** The platform took the money. `platformChargeId` is the settlement reference. */
export interface PaymentSucceededEvent {
  kind: 'payment_succeeded';
  chatId: string;
  fromId: string;
  currency: string;
  totalAmount: number;
  payload: string;
  platformChargeId: string;
  /** Empty on Stars; the platform sends `''`, read here as absent. */
  providerChargeId: string | null;
}

export type PaymentEvent = PreCheckoutEvent | PaymentSucceededEvent;

/**
 * The payment event an update carries, or `null` — for an update that is not
 * a payment, and for one missing a field the settlement needs. A half-read
 * payment is never passed on: it would settle against a guess.
 */
export function parsePaymentEvent(update: BotUpdate): PaymentEvent | null {
  const q = update.pre_checkout_query;
  if (q) {
    if (
      !q.id ||
      q.from?.id === undefined ||
      !q.currency ||
      !Number.isInteger(q.total_amount) ||
      !q.invoice_payload
    ) {
      return null;
    }
    return {
      kind: 'pre_checkout',
      queryId: q.id,
      fromId: String(q.from.id),
      currency: q.currency,
      totalAmount: q.total_amount,
      payload: q.invoice_payload,
    };
  }

  const m = update.message;
  const paid = m?.successful_payment;
  if (!paid) return null;
  if (
    m.chat?.id === undefined ||
    m.from?.id === undefined ||
    !paid.currency ||
    !Number.isInteger(paid.total_amount) ||
    !paid.invoice_payload ||
    !paid.telegram_payment_charge_id
  ) {
    return null;
  }
  return {
    kind: 'payment_succeeded',
    chatId: String(m.chat.id),
    fromId: String(m.from.id),
    currency: paid.currency,
    totalAmount: paid.total_amount,
    payload: paid.invoice_payload,
    platformChargeId: paid.telegram_payment_charge_id,
    providerChargeId: paid.provider_payment_charge_id || null,
  };
}
