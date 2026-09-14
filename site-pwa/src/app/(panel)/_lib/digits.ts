/**
 * Numbers are written in Latin digits in every language (2026-09-13). The
 * language keeps its calendar, grouping words and direction; only the digit
 * glyphs are fixed. Every `Intl` formatter in the panel takes its locale from
 * here, and the date picker takes {@link LATIN_DIGITS}.
 */
export const numberLocale = (lang: string) => `${lang}-u-nu-latn`;

export const LATIN_DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
