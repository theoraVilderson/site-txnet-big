/**
 * F-1507 (ADR-0109 point 10): an AI message carries at most one call to
 * action and never pressures — no artificial urgency, no false scarcity, no
 * guilt. One rule, three places:
 *
 * - **template lint** — every language's `notifications.suggestion.*` passes
 *   it (`suggestion-copy.spec.ts`), so a copy edit that pressures is red;
 * - **output validation** — the final text and its buttons, where they are
 *   rendered, before any channel (auth-service `UserNotifier`); a model's
 *   rewrite (F-1542) passes the same check before it is kept;
 * - **the prompt** — {@link SUGGESTION_COPY_PROMPT}, for the language layer.
 *
 * A factual deadline ("ends in 3 days") is not urgency, and a user's own
 * traffic running out is not scarcity: the rule bans pressure, not facts.
 * "Don't show this again" is a control, not a call to action.
 */

export type SuggestionCopyRule = 'cta' | 'urgency' | 'scarcity' | 'guilt';
export type SuggestionCopyVerdict = { ok: true } | { ok: false; rule: SuggestionCopyRule };

/** The most calls to action one AI message may carry — buttons and links together. */
export const SUGGESTION_MAX_CTAS = 1;

/** The same rule in words, for a model's instructions (F-1542). */
export const SUGGESTION_COPY_PROMPT =
  'Offer at most one call to action and include no link. State facts only: no urgency (hurry, now, last chance, today only, exclamation marks), ' +
  'no scarcity (only N left, limited spots), no guilt (regret, "don\'t you want"). Never invent a deadline, a number or a price.';

const LINK = /(?:https?:\/\/|www\.|t\.me\/)\S+/g;

const PATTERNS: Array<[Exclude<SuggestionCopyRule, 'cta'>, RegExp[]]> = [
  [
    'urgency',
    [
      /!/,
      /\bhurry\b/,
      /\bact (?:now|fast|quickly)\b/,
      /\bright now\b/,
      /\bimmediately\b/,
      /\blast chance\b/,
      /\b(?:today|tonight) only\b/,
      /\bonly (?:today|tonight)\b/,
      /\bdon't miss\b/,
      /\btoo late\b/,
      /\bnow or never\b/,
      /\blimited[- ]time\b/,
      /عجله/,
      /آخرین فرصت|فرصت آخر/,
      /همین (?:الان|حالا)/,
      /فقط (?:امروز|امشب)/,
      /از دست(?:ش)? ندهید/,
      /تا دیر نشده/,
      /فوری|فورا/,
      /(?:زمان|مهلت) محدود/,
    ],
  ],
  [
    'scarcity',
    [
      /\bonly [0-9]+ (?:\w+ )?(?:left|remaining)\b/,
      /\blimited (?:spots|stock|seats|supply|availability|places|capacity)\b/,
      /\b(?:few|handful) left\b/,
      /\bselling (?:out|fast)\b/,
      /\balmost gone\b/,
      /\bwhile (?:supplies|stocks?) last\b/,
      /\bin high demand\b/,
      /(?:ظرفیت|تعداد|موجودی) محدود/,
      /فقط [0-9۰-۹]+ .{0,20}(?:باقی|مانده)/,
    ],
  ],
  [
    'guilt',
    [
      /\bregret\b/,
      /\bdon't you want\b/,
      /\bare you sure you want to (?:lose|miss)\b/,
      /\bdon't let .{0,20}down\b/,
      /\bshame\b/,
      /پشیمان/,
      /حیف/,
      /مگر نمی ?خواهید/,
    ],
  ],
];

/** Case, curly apostrophes, the zero-width non-joiner and Arabic letter forms read as one. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/‌/g, ' ')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/\s+/g, ' ');
}

/** `ctas`: the message's action buttons (never its "don't show this again"). */
export function suggestionCopyVerdict(message: { text: string; ctas: number }): SuggestionCopyVerdict {
  const links = message.text.match(LINK)?.length ?? 0;
  if (message.ctas + links > SUGGESTION_MAX_CTAS) return { ok: false, rule: 'cta' };
  const text = normalize(message.text);
  for (const [rule, patterns] of PATTERNS) {
    if (patterns.some((p) => p.test(text))) return { ok: false, rule };
  }
  return { ok: true };
}
