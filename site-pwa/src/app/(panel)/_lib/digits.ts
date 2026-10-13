/**
 * Numbers are written in Latin digits in every language (2026-09-13). The
 * language keeps its calendar, grouping words and direction; only the digit
 * glyphs are fixed. Every `Intl` formatter in the panel takes its locale from
 * here, and the date picker takes {@link LATIN_DIGITS}.
 */
export const numberLocale = (lang: string) => `${lang}-u-nu-latn`;

export const LATIN_DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * `["a", "b", "c"]` -> `a, b, and c` / `a، b، و c`: the reader's separator and
 * conjunction from `Intl.ListFormat`, never one language's comma (FE-1-b).
 */
export const formatList = (items: readonly string[], lang: string): string =>
  new Intl.ListFormat(lang, { style: "long", type: "conjunction" }).format(items);
