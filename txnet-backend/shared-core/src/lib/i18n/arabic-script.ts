/**
 * The backend's one script module (C-19, CS-1-d): every table that knows the
 * Arabic script's letters and digits, so a fold is written once and a caller
 * imports it. Persian and Arabic share a script but not a keyboard — the same
 * word reaches us as `ي` or `ی`, `ك` or `ک`, with digits in three scripts —
 * and none of that is a typo a user can be asked to fix.
 *
 * Each caller keeps its own fold on purpose: a saved label folds only what its
 * migration folded, a search folds more, a slug leaves the script entirely.
 */

/** Persian and Arabic-Indic digits, each as its ASCII digit. */
const ASCII_DIGIT_OF: Readonly<Record<string, string>> = Object.fromEntries(
  ['۰۱۲۳۴۵۶۷۸۹', '٠١٢٣٤٥٦٧٨٩'].flatMap((digits) => [...digits].map((d, i) => [d, String(i)])),
);

/**
 * Arabic code points a Persian letter is also typed with. A config label's
 * migration `20260926001000_config_label_one_spelling` folds exactly these
 * pairs, so they must stay these (F-307-o).
 */
const PERSIAN_LETTER_OF: Readonly<Record<string, string>> = { ي: 'ی', ى: 'ی', ك: 'ک' };

/** What a search also folds (F-414-j): the hamza seats and ta marbuta, as the letter a reader types. */
const SEARCH_LETTER_OF: Readonly<Record<string, string>> = {
  ...PERSIAN_LETTER_OF,
  ة: 'ه',
  أ: 'ا',
  إ: 'ا',
  آ: 'ا',
  ؤ: 'و',
};

const ONE_SPELLING_OF: Readonly<Record<string, string>> = { ...PERSIAN_LETTER_OF, ...ASCII_DIGIT_OF };
const SEARCH_FOLD_OF: Readonly<Record<string, string>> = { ...SEARCH_LETTER_OF, ...ASCII_DIGIT_OF };

/** Harakat, superscript alef and tatweel: marks a reader does not type when searching. */
const MARKS = /[ً-ٰٟـ]/g;

/** Letters a search must not tell apart (F-092-n); `ئ` is a `ی` here, as legacy matched it. */
const SAME_LETTER_GROUPS: readonly string[] = ['آا', 'یيئ', 'کك', 'هة'];

const SAME_LETTER_PATTERN: Readonly<Record<string, string>> = Object.fromEntries(
  SAME_LETTER_GROUPS.flatMap((group) => [...group].map((ch) => [ch, `[${group}]`])),
);

/** Each letter's usual Latin spelling (F-019-h); vowels Persian does not write stay unwritten. */
const LATIN_SPELLING_OF: Readonly<Record<string, string>> = {
  ...ASCII_DIGIT_OF,
  ا: 'a', آ: 'a', أ: 'a', إ: 'e', ء: '', ئ: 'y', ؤ: 'v',
  ب: 'b', پ: 'p', ت: 't', ث: 's', ج: 'j', چ: 'ch', ح: 'h', خ: 'kh',
  د: 'd', ذ: 'z', ر: 'r', ز: 'z', ژ: 'zh', س: 's', ش: 'sh', ص: 's',
  ض: 'z', ط: 't', ظ: 'z', ع: 'a', غ: 'gh', ف: 'f', ق: 'gh', ک: 'k',
  ك: 'k', گ: 'g', ل: 'l', م: 'm', ن: 'n', و: 'v', ه: 'h', ة: 'h',
  ی: 'y', ي: 'y', ى: 'y',
};

/**
 * Persian words that say nothing about which guide is meant (F-414-k): a
 * greeting, a pronoun, a particle. Language-specific matching, so it lives
 * with the script (C-19); already in {@link foldForSearch}'s spelling.
 */
export const PERSIAN_STOP_WORDS: readonly string[] = (
  'سلام روی برای این اون آن که از به با را در تا هم من ما شما یک چرا چطور چه چی نمی میشه نمیشه کنم کنید دارم است هست ولی اما لطفا ممنون مرسی خیلی'
)
  .split(' ')
  .map((w) => foldForSearch(w));

function mapChars(text: string, table: Readonly<Record<string, string>>): string {
  return Array.from(text, (ch) => table[ch] ?? ch).join('');
}

/** A saved label in one spelling: Arabic `ي`/`ى`/`ك` as Persian and every digit as ASCII; nothing else changes. */
export function foldToOneSpelling(text: string): string {
  return mapChars(text, ONE_SPELLING_OF);
}

/** A text as a search compares it: {@link foldToOneSpelling}, plus hamza seats and ta marbuta folded and marks dropped. */
export function foldForSearch(text: string): string {
  return mapChars(text, SEARCH_FOLD_OF).replace(MARKS, '');
}

/** A regex character class matching every spelling of `char`, or `undefined` when it has only one. */
export function sameLetterPattern(char: string): string | undefined {
  return SAME_LETTER_PATTERN[char];
}

/** A name with each Arabic-script letter and digit spelled in Latin; any other character is kept. */
export function transliterateToLatin(text: string): string {
  return mapChars(text, LATIN_SPELLING_OF);
}
