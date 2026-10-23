/**
 * Balances from a file, the reseller's screen (F-209-b, D-63; billing
 * `contract.balance-import.md`). Billing parses, plans, credits and takes back;
 * the rules held here are the page's own:
 *
 *  - the template is the three columns billing reads, saved so a spreadsheet
 *    opens it as UTF-8 (a Persian username survives the round trip);
 *  - a file past billing's bound, or empty, is said before it is sent — a
 *    100 KB body would come back as a bare 413, not a sentence;
 *  - a balance file's run has no login, no mapping and no old address: a run
 *    the dry run could not finish is checked again, never asked for a login;
 *  - its report reads the row's line, amount and currency, and its reasons
 *    are a balance file's sentences, not a panel's.
 */
import { describe, expect, it } from "vitest";
import type { MigrationRun } from "@/lib/billing-api";
import { BALANCE_FILE_MAX_CHARS, BALANCE_TEMPLATE_HREF, balanceFileError, reasonTablesOf } from "./_lib/migration-csv";
import { MIGRATION_KEYS as K, stageOf } from "./_lib/migration";
import { runTitleOf } from "./_lib/migration-link";

const run = (over: Partial<MigrationRun> = {}): MigrationRun => ({
  id: "run-1",
  kind: "csv",
  sourceFamily: null,
  sourceAddress: null,
  sourcePanelId: null,
  status: "previewed",
  failureReason: null,
  plannedCreate: 2,
  plannedUpdate: 0,
  plannedSkip: 1,
  committedItems: 0,
  failedItems: 0,
  rollbackUntil: null,
  snapshotsPurgedAt: null,
  userId: null,
  variantId: null,
  createdAt: "2026-10-22T08:00:00Z",
  updatedAt: "2026-10-22T08:00:00Z",
  ...over,
});

describe("the template", () => {
  it("is billing's three columns, marked UTF-8 for a spreadsheet", () => {
    expect(BALANCE_TEMPLATE_HREF.startsWith("data:text/csv;charset=utf-8,")).toBe(true);
    const body = decodeURIComponent(BALANCE_TEMPLATE_HREF.slice(BALANCE_TEMPLATE_HREF.indexOf(",") + 1));
    expect(body).toBe("﻿user,amount,currency\n");
  });
});

describe("balanceFileError", () => {
  it("says an empty file and one past billing's bound before sending them", () => {
    expect(balanceFileError("  \n")).toBe(K.csv.empty);
    expect(balanceFileError("x".repeat(BALANCE_FILE_MAX_CHARS + 1))).toBe(K.csv.tooLong);
    expect(balanceFileError("user,amount,currency\nali,5,USD\n")).toBeNull();
  });
});

describe("a balance file's run", () => {
  it("is never asked for a login: a draft is checked again", () => {
    expect(stageOf(run({ status: "draft" }))).toBe("retry");
    expect(stageOf(run())).toBe("report");
  });

  it("is titled as a file, with no source to name", () => {
    expect(runTitleOf(run())).toEqual({ key: K.csv.historyRow, values: {} });
  });

  it("reads its reasons from a balance file's sentences", () => {
    expect(reasonTablesOf("csv")).toEqual({ skip: K.csv.skip, itemFailure: K.csv.itemFailure, kept: K.csv.kept });
    expect(reasonTablesOf("panel")).toEqual({ skip: K.skip, itemFailure: K.itemFailure, kept: K.kept });
    expect(Object.keys(K.csv.skip).sort()).toEqual(["ambiguous_user", "currency_mismatch", "duplicate", "unknown_user", "unreadable"]);
  });
});
