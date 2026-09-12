/**
 * The financial page's search, folded the way a Persian keyboard needs it
 * (F-092-n) — a port of legacy `financial/_actions/balanceCalc.ts`
 * `createAdvancedSearchQuery`.
 *
 * Persian and Arabic share a script but not a keyboard. The same word reaches
 * us spelled with `ی` or `ي`, `ک` or `ك`, `ه` or `ة`, `ا` or `آ`, and a
 * compound word is written with a space on one keyboard and a ZWNJ
 * (`U+200C`) on another. None of that is a typo the user can be asked to fix:
 * both spellings are correct, and an exact match answers "no results" to a
 * search the user typed right.
 *
 * Two things differ from legacy on purpose:
 *  - a ZWNJ **in the term** is folded too. Legacy collapsed `\s+` into
 *    `[\s\u200c]+`, so "زرین پال" found "زرین‌پال" but not the other way
 *    round — and the panel's own labels are the side that carries the ZWNJ;
 *  - it produces a matcher, not a database predicate. Legacy handed the regex
 *    to Mongo; here it runs in process over a fixed set of translated labels
 *    (`wallet-history.service.ts`), so a term is never interpolated into SQL.
 *
 * The term is escaped before any of this: a user typing `.` or `(` is typing
 * text, not a pattern.
 */

/** Both sides of each pair mean the same letter; a search must not tell them apart. */
const VARIANTS: Record<string, string> = {
  آ: '(آ|ا)',
  ا: '(آ|ا)',
  ی: '(ی|ي|ئ)',
  ي: '(ی|ي|ئ)',
  ئ: '(ی|ي|ئ)',
  ک: '(ک|ك)',
  ك: '(ک|ك)',
  ه: '(ه|ة)',
  ة: '(ه|ة)',
};

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** A gap the user typed, however they typed it: spaces, or the ZWNJ a compound word is written with. */
const GAP = /[\s\u200c]+/g;

/**
 * The matcher for a search term, or `null` when there is nothing to search for.
 *
 * A blank term is `null` rather than a pattern that matches everything, so a
 * caller cannot accidentally turn "the user typed nothing" into a filter.
 */
export function foldedSearch(term: string): RegExp | null {
  const trimmed = term.trim();
  if (trimmed.length === 0) return null;

  const escaped = trimmed.replace(REGEX_SPECIAL, '\\$&').replace(GAP, '\u0000');
  const folded = [...escaped]
    .map((char) => (char === '\u0000' ? '[\\s\\u200c]+' : (VARIANTS[char] ?? char)))
    .join('');
  return new RegExp(folded, 'i');
}

/** Whether `text` contains `term`, with every variant above folded. A blank term matches nothing. */
export function matchesFolded(term: string, text: string): boolean {
  const pattern = foldedSearch(term);
  return pattern !== null && pattern.test(text);
}
