/**
 * An amount's currency as a word in the reader's language (2026-10-15: "2.00
 * was added" said nothing of rials, toman or dollars). The names live once, at
 * `bot.money.currency` — what the chat already calls them — read here by the
 * `currencyCode` param; a code with no name is shown as the code, and no code
 * leaves `currency` empty rather than an unfilled placeholder.
 */
export function withCurrencyName(params: Record<string, string>, botNamespace: unknown): Record<string, string> {
  if (params.currency !== undefined) return params;
  const code = params.currencyCode ?? '';
  return { ...params, currency: (code && namesOf(botNamespace)[code]) || code };
}

function namesOf(botNamespace: unknown): Record<string, string> {
  const money = (botNamespace as { money?: { currency?: unknown } } | undefined)?.money?.currency;
  return money && typeof money === 'object' ? (money as Record<string, string>) : {};
}
