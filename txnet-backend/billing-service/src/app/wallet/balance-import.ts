import { MigrationItemAction, MigrationSkipReason, Prisma, WalletReasonType, type MigrationItem, type MigrationRun } from '@prisma/client';
import { foldToOneSpelling, MONEY_PATTERN } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { TELEGRAM_ID } from '../entitlement/migration-plan';
import type { PlannedRunItem, RunPlan } from '../entitlement/migration-run-plan';
import type { TelegramClaim, TelegramClaimAnswer } from '../entitlement/migration-seams';
import type { WalletCreditService } from './wallet-credit.service';
import { LedgerCurrencyMismatch } from './wallet-ledger.service';

/*
 * A reseller's balances brought from its old panel in a file (F-209-a,
 * billing `contract.balance-import.md`): a `csv` run on the import engine.
 * Pure parts — the file, the plan — and the commit's write for a row; the
 * rollback's is `balance-import-rollback.ts`. Money moves only as ledger rows (catalog §16).
 */

/** The longest file taken: under the JSON body's 100 KB with room for its quoting. ~3 500 rows of a username, an amount and a code. */
export const BALANCE_FILE_MAX_CHARS = 90_000;
/** Rows per file: one dry run writes them all in one transaction, as a panel's report. */
export const BALANCE_ROWS_MAX = 5_000;
/** The file's columns, by header name; any order, other columns ignored. */
const COLUMNS = ['user', 'amount', 'currency'] as const;
/** An optional column: the person's Telegram account, claimed for them at the commit (F-210). */
const TELEGRAM_COLUMN = 'telegram';
/** A person's username, phone or import key as the file names them (identity's columns are no longer). */
const USER_MAX = 200;
/** What a cell may hold before it is kept: longer is unreadable, and only its start is shown. */
const CELL_KEPT = 64;
/** The separators a spreadsheet saves a CSV with, by locale. */
const SEPARATORS = [',', ';', '\t'] as const;
/** Grouping marks a typed amount may carry: Latin and Arabic thousands separators, spaces. */
const GROUPING = /[\s,\u066C_]/g;
/** A phone as a person types it, once its digits are folded: what identity stores is E.164. */
const PHONE_LIKE = /^\+?\d+$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

/** Declared once (C-09): why a whole file is refused before any run is made. */
export const BALANCE_FILE_REFUSALS = ['csv_columns', 'csv_empty', 'csv_too_many_rows'] as const;
export type BalanceFileRefusal = (typeof BALANCE_FILE_REFUSALS)[number];

export class BalanceFileRefused extends Error {
  constructor(readonly reason: BalanceFileRefusal) {
    super(`balance file refused: ${reason}`);
    this.name = 'BalanceFileRefused';
  }
}

/** Why one row's write did not happen: kept as the item's failure (commit) or `keptReason` (rollback). */
export class BalanceRowRefused extends Error {
  constructor(readonly reason: 'user_not_found' | 'currency_mismatch' | 'wallet_used') {
    super(`balance row refused: ${reason}`);
    this.name = 'BalanceRowRefused';
  }
}

/** One data row as read: its line in the file (the header is 1), each cell trimmed; `telegram` only where the file has the column and the cell is not blank. */
export type BalanceRow = { line: number; user: string; amount: string; currency: string; telegram?: string };

/** One CSV record's cells: double quotes may hold a separator, `""` is a quote. A record never spans lines. */
function cellsOf(line: string, separator: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let at = 0; at < line.length; at += 1) {
    const ch = line[at];
    if (quoted && ch === '"' && line[at + 1] === '"') {
      cell += '"';
      at += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted && ch === separator) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

/** The separator the header was saved with: the one that splits it into the most cells. */
const separatorOf = (header: string): string => SEPARATORS.reduce((best, s) => (cellsOf(header, s).length > cellsOf(header, best).length ? s : best));

/** Digits in any script folded; a phone-shaped name takes the fold, any other name stays as typed (a username is exact). */
function userOf(cell: string): string {
  const folded = foldToOneSpelling(cell).replace(/[\s-]/g, '');
  return PHONE_LIKE.test(folded) ? folded : cell;
}

/**
 * The file's rows (F-209-a): a header naming `user`, `amount` and `currency`
 * (any case, any order) and optionally `telegram` (F-210), then one row per
 * balance; blank lines skipped. The
 * cells are not judged here — a bad one is the plan's `unreadable` — only a
 * file no row can be read from is refused.
 */
export function parseBalanceFile(text: string): BalanceRow[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const separator = separatorOf(lines[0] ?? '');
  const header = cellsOf(lines[0] ?? '', separator).map((c) => c.toLowerCase());
  const at = COLUMNS.map((c) => header.indexOf(c));
  if (at.some((i) => i < 0)) throw new BalanceFileRefused('csv_columns');
  const [userAt, amountAt, currencyAt] = at;
  const telegramAt = header.indexOf(TELEGRAM_COLUMN);
  const rows: BalanceRow[] = [];
  for (let n = 1; n < lines.length; n += 1) {
    if (lines[n].trim() === '') continue;
    if (rows.length === BALANCE_ROWS_MAX) throw new BalanceFileRefused('csv_too_many_rows');
    const cells = cellsOf(lines[n], separator);
    const cell = (i: number) => (cells[i] ?? '').slice(0, i === userAt ? USER_MAX + 1 : CELL_KEPT);
    const telegram = telegramAt < 0 ? '' : foldToOneSpelling(cell(telegramAt)).replace(/\s/g, '');
    rows.push({
      line: n + 1,
      user: userOf(cell(userAt)),
      amount: foldToOneSpelling(cell(amountAt)).replace(GROUPING, ''),
      currency: cell(currencyAt).toUpperCase(),
      ...(telegram ? { telegram } : {}),
    });
  }
  if (rows.length === 0) throw new BalanceFileRefused('csv_empty');
  return rows;
}

/** An item's key: unique in its run, zero-padded so the report's order (by key) is the file's. */
export const balanceItemKey = (line: number): string => `csv|${String(line).padStart(6, '0')}`;

/** What the dry run asks of the tenant, read once for the whole file (C-28). */
export type BalancePlanContext = {
  /** The people each name matches by username, phone or import key — deleted people left out. */
  peopleOf: ReadonlyMap<string, readonly string[]>;
  /** The currency a person's money is kept in: their wallet's, else the tenant's (a wallet opens in its first credit's). */
  currencyOf: (userId: string) => string;
  /** The places of a currency `currencyOf` answers. */
  placesOf: (currencyCode: string) => number;
};

/** The row as its item keeps it: read back by a re-preview, the commit and the report. */
export const balanceSnapshotSchema = z.object({
  line: z.number().int().positive(),
  user: z.string(),
  amount: z.string(),
  currency: z.string(),
  userId: z.string().uuid().optional(),
  /** The Telegram account the row named, claimed for its person at the commit (F-210). */
  telegramId: z.string().regex(TELEGRAM_ID).optional(),
});
export type BalanceSnapshot = z.infer<typeof balanceSnapshotSchema>;

/** A positive decimal the money columns hold; its places are judged against the wallet's currency later. */
const amountReadable = (amount: string): boolean => MONEY_PATTERN.test(amount) && new Prisma.Decimal(amount).gt(0);
/** No more places than its currency's: refused, never rounded (ADR-0153). */
const amountFits = (amount: string, places: number): boolean => new Prisma.Decimal(amount).decimalPlaces() <= places;

/** One row's answer: whom it credits, or why it is reported instead. */
function planRow(row: BalanceRow, context: BalancePlanContext, credited: Set<string>): { userId?: string; skipReason: MigrationSkipReason | null } {
  if (row.user === '' || row.user.length > USER_MAX || !amountReadable(row.amount) || !CURRENCY_CODE.test(row.currency)) return { skipReason: MigrationSkipReason.unreadable };
  if (row.telegram !== undefined && !TELEGRAM_ID.test(row.telegram)) return { skipReason: MigrationSkipReason.unreadable };
  const people = [...new Set(context.peopleOf.get(row.user) ?? [])];
  if (people.length === 0) return { skipReason: MigrationSkipReason.unknown_user };
  if (people.length > 1) return { skipReason: MigrationSkipReason.ambiguous_user };
  const [userId] = people;
  if (credited.has(userId)) return { userId, skipReason: MigrationSkipReason.duplicate };
  const currency = context.currencyOf(userId);
  if (row.currency !== currency) return { userId, skipReason: MigrationSkipReason.currency_mismatch };
  if (!amountFits(row.amount, context.placesOf(currency))) return { userId, skipReason: MigrationSkipReason.unreadable };
  credited.add(userId);
  return { userId, skipReason: null };
}

/**
 * The dry run's report of a file (F-209-a), in its order: a credit for each
 * row naming one person in their wallet's currency; else `unreadable`,
 * `unknown_user`, `ambiguous_user`, `duplicate` (a second row for one person)
 * or `currency_mismatch`. Nothing is written here.
 */
export function planBalanceRows(rows: readonly BalanceRow[], context: BalancePlanContext): RunPlan {
  const credited = new Set<string>();
  const items: PlannedRunItem[] = rows.map((row) => {
    const { userId, skipReason } = planRow(row, context, credited);
    const credits = userId && !skipReason;
    const snapshot: BalanceSnapshot = { line: row.line, user: row.user, amount: row.amount, currency: row.currency, ...(credits ? { userId } : {}), ...(credits && row.telegram ? { telegramId: row.telegram } : {}) };
    return { remoteIdentity: balanceItemKey(row.line), sourceSnapshot: snapshot, plannedAction: skipReason ? MigrationItemAction.skip : MigrationItemAction.create, skipReason };
  });
  const plannedCreate = items.filter((i) => i.plannedAction === MigrationItemAction.create).length;
  return { items, plannedCreate, plannedUpdate: 0, plannedSkip: items.length - plannedCreate, unaddressed: 0 };
}

/** A csv run's person: found, never made; the Telegram id its row named, and what claiming it came to (F-210). */
export type CsvPerson = { userId: string; created: false; telegramId?: string; telegram?: string };
export type CsvPeople = { made: Map<string, CsvPerson>; refused: Map<string, string> };

/** A csv run's batch's people: the ones its dry run named, found and never made — so a rollback never removes them. */
export function csvPeopleOf(batch: ReadonlyArray<Pick<MigrationItem, 'remoteIdentity' | 'sourceSnapshot'>>): CsvPeople {
  const made = new Map<string, CsvPerson>();
  const refused = new Map<string, string>();
  for (const item of batch) {
    const snapshot = balanceSnapshotSchema.safeParse(item.sourceSnapshot).data;
    if (snapshot?.userId) made.set(item.remoteIdentity, { userId: snapshot.userId, created: false, ...(snapshot.telegramId ? { telegramId: snapshot.telegramId } : {}) });
    else refused.set(item.remoteIdentity, 'user_not_found');
  }
  return { made, refused };
}

/** The batch's Telegram column claimed through identity (F-210), each outcome written onto its person; nothing asked when no row named one. */
export async function withCsvTelegram(people: CsvPeople, claim: (links: TelegramClaim[]) => Promise<TelegramClaimAnswer>): Promise<CsvPeople> {
  const links = [...people.made.values()].flatMap((p) => (p.telegramId ? [{ userId: p.userId, chatId: p.telegramId }] : []));
  if (links.length === 0) return people;
  const outcomeOf = new Map((await claim(links)).links.map((l) => [l.userId, l.telegram]));
  for (const person of people.made.values()) {
    const telegram = person.telegramId && outcomeOf.get(person.userId);
    if (telegram) person.telegram = telegram;
  }
  return people;
}

/**
 * The commit's write for one row (F-209-a): one `migration_import` credit
 * naming the item, through `WalletCreditService` like every user credit, so a
 * Grant the money funds is revived with it. The caller's transaction also
 * settles the item, so a row retried is credited once (and a unique index
 * holds it). A person deleted since the dry run is refused, and so is a
 * wallet whose currency changed since with no recorded change to convert by.
 */
export async function creditBalanceRow(
  tx: Prisma.TransactionClient,
  credits: Pick<WalletCreditService, 'credit'>,
  run: Pick<MigrationRun, 'tenantId'>,
  item: Pick<MigrationItem, 'id' | 'sourceSnapshot'>,
  userId: string,
): Promise<void> {
  const row = balanceSnapshotSchema.parse(item.sourceSnapshot);
  const person = await tx.user.findFirst({ where: { id: userId, tenantId: run.tenantId, deletedAt: null }, select: { id: true } });
  if (!person) throw new BalanceRowRefused('user_not_found');
  try {
    await credits.credit(tx, { userId, amount: new Prisma.Decimal(row.amount), currencyCode: row.currency, reasonType: WalletReasonType.migration_import, referenceId: item.id });
  } catch (e) {
    if (e instanceof LedgerCurrencyMismatch) throw new BalanceRowRefused('currency_mismatch');
    throw e;
  }
}
