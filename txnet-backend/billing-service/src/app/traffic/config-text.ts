/**
 * A config's name in one spelling (F-307-o, user 2026-09-26): what a buyer
 * saves as a label, what the grant list's `q` is, and a default line name
 * before `q` is matched against it.
 *
 * Arabic and Persian keyboards type the same word with different code
 * points — `ي`/`ى` for `ی`, `ك` for `ک` — and digits in three scripts. The
 * label is folded when it is saved rather than at search time, so the list
 * stays one indexed `contains`; the migration
 * `20260926001000_config_label_one_spelling` folds the labels saved before.
 * Its `translate()` pairs are these, and must stay these.
 *
 * Case, spacing and the ZWNJ are the buyer's and are left alone: the search
 * is already case-insensitive, and a ZWNJ is how the word is written.
 */
const ONE_SPELLING: Record<string, string> = {
  ي: 'ی',
  ى: 'ی',
  ك: 'ک',
  ...Object.fromEntries([...'۰۱۲۳۴۵۶۷۸۹'].map((d, i) => [d, String(i)])),
  ...Object.fromEntries([...'٠١٢٣٤٥٦٧٨٩'].map((d, i) => [d, String(i)])),
};

const FOLDABLE = new RegExp(`[${Object.keys(ONE_SPELLING).join('')}]`, 'g');

export function foldConfigText(text: string): string {
  return text.replace(FOLDABLE, (c) => ONE_SPELLING[c]);
}
