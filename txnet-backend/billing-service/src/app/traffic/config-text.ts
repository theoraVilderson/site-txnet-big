import { foldToOneSpelling } from '@txnet-backend/shared-core';

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
 * Its `translate()` pairs are shared-core's `foldToOneSpelling` (C-19), and
 * must stay those.
 *
 * Case, spacing and the ZWNJ are the buyer's and are left alone: the search
 * is already case-insensitive, and a ZWNJ is how the word is written.
 */
/** The label as saved and searched. */
export function foldConfigText(text: string): string {
  return foldToOneSpelling(text);
}
