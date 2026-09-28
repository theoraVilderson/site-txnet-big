import { BotText } from '@txnet-backend/messenger';
import { BotKeys } from './bot-keys';

/** The currencies the bot has a translated name for; any other prints as its code. */
const CURRENCY_NAME = {
  IRT: BotKeys.money.currency.IRT,
  IRR: BotKeys.money.currency.IRR,
  USD: BotKeys.money.currency.USD,
} as const;

/** A currency's name in the chat's language — the code itself when it has none here. */
export function currencyName(currencyCode: string): BotText {
  return Object.prototype.hasOwnProperty.call(CURRENCY_NAME, currencyCode)
    ? { key: CURRENCY_NAME[currencyCode as keyof typeof CURRENCY_NAME] }
    : { raw: currencyCode };
}

/**
 * An amount as the chat shows it: the figure and the currency it is in
 * (F-116-h4, ADR-0098 part 3). The figure is billing's decimal string, untouched
 * — the bot does no arithmetic and no conversion. The code is the one billing
 * answered **beside that figure**, never the tenant's now: a row written before
 * a currency change stays in the currency it was written in.
 *
 * A code with no name here prints as the code itself — `12.00 EUR` still says
 * what it is. Only an answer that named no currency (an older billing on a
 * rolling deploy) leaves the figure bare.
 */
export function money(amount: string, currencyCode: string | null | undefined): BotText {
  if (!currencyCode) return { raw: amount };
  return { key: BotKeys.money.amount, values: { amount, currency: currencyName(currencyCode) } };
}

/** One currency's figure, as billing answers it beside a converted total. */
export interface CurrencyAmount {
  currencyCode: string;
  total: string;
}

/**
 * A total billing converted into one currency, or — when it could not
 * (`total: null`, no `currency_change` leads there) — each currency as it was
 * taken, listed and never added (F-116-h9, ADR-0098 part 3). Adding them is
 * dollars and rials summed as one number; the bot converts nothing itself.
 */
export function moneyTotal(
  total: string | null,
  currencyCode: string | null | undefined,
  byCurrency: CurrencyAmount[] = [],
): BotText {
  if (total !== null) return money(total, currencyCode);
  const parts = byCurrency.map((c) => money(c.total, c.currencyCode));
  if (parts.length === 0) return money('0.00', currencyCode);
  return parts.reduceRight((rest, first) => ({ key: BotKeys.money.list, values: { first, rest } }));
}
