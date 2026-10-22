import type { MigrationRun } from "@/lib/billing-api";
import { MIGRATION_KEYS as K } from "./migration";

/**
 * Balances from a file, the reseller's screen (F-209-b, D-63; billing
 * `contract.balance-import.md`). Billing parses the file, plans each row,
 * credits and takes back; these are the page's rules: the template it hands
 * out, what it says before sending, and which sentences a row's reasons read.
 */

/** billing's `BALANCE_FILE_MAX_CHARS`: a longer file would meet the 100 KB body limit as a bare 413. */
export const BALANCE_FILE_MAX_CHARS = 90_000;

/** The columns billing reads by name (rule 1); a byte-order mark so a spreadsheet opens the file as UTF-8. */
const TEMPLATE = "﻿user,amount,currency\n";

/** The template as a link the page downloads without a round trip. */
export const BALANCE_TEMPLATE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`;

/** The template's file name when saved. */
export const BALANCE_TEMPLATE_NAME = "balances.csv";

/** What a picker offers: a CSV, or the plain text a spreadsheet may save one as. */
export const BALANCE_FILE_ACCEPT = ".csv,text/csv,text/plain";

/** The file's error key, or null: empty, or past billing's bound. Its rows are billing's to judge. */
export function balanceFileError(text: string): string | null {
  if (text.trim() === "") return K.csv.empty;
  return text.length > BALANCE_FILE_MAX_CHARS ? K.csv.tooLong : null;
}

/** The sentence tables a run's row reasons read: a balance file's rows fail for their own reasons (billing rules 5–7). */
export function reasonTablesOf(kind: MigrationRun["kind"]) {
  return kind === "csv" ? { skip: K.csv.skip, itemFailure: K.csv.itemFailure, kept: K.csv.kept } : { skip: K.skip, itemFailure: K.itemFailure, kept: K.kept };
}
