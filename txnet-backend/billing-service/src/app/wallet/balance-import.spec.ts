import { LedgerDirection, MigrationItemAction, MigrationSkipReason, Prisma, WalletReasonType } from '@prisma/client';

import {
  BalanceFileRefused,
  BalanceRowRefused,
  balanceItemKey,
  creditBalanceRow,
  csvPeopleOf,
  withCsvTelegram,
  parseBalanceFile,
  planBalanceRows,
  type BalancePlanContext,
} from './balance-import';
import { reverseBalanceRow } from './balance-import-rollback';
import { InsufficientFunds, LedgerCurrencyMismatch } from './wallet-ledger.service';

/**
 * F-209-a: a reseller's balances brought in from a file. What fails silently
 * here: a row naming nobody credited to someone (or dropped unreported), a
 * row read twice credited twice, an amount in another currency credited as if
 * it were the wallet's, a balance set by an UPDATE instead of a ledger row
 * (the nightly reconciliation's Sev-1, catalog §16) — and a rollback that
 * takes back money the user has since spent or added to.
 */
const TENANT = '00000000-0000-4000-8000-0000000000aa';
const RUN = { id: '00000000-0000-4000-8000-000000000209', tenantId: TENANT };
const ALICE = '00000000-0000-4000-8000-00000000a11c';
const BOB = '00000000-0000-4000-8000-000000000b0b';

describe('parseBalanceFile', () => {
  it('reads the three columns by name, in any order, under any of the separators a spreadsheet saves', () => {
    const rows = parseBalanceFile('\uFEFFamount;Currency;user\r\n"1,250.50";irr;alice\n\n300;IRR;+989121234567\n');
    expect(rows).toEqual([
      { line: 2, user: 'alice', amount: '1250.50', currency: 'IRR' },
      { line: 4, user: '+989121234567', amount: '300', currency: 'IRR' },
    ]);
  });

  it('folds Persian digits in the amount and a phone, and leaves a username as typed', () => {
    expect(parseBalanceFile('user,amount,currency\n+۹۸۹۱۲۱۲۳۴۵۶۷,۱۲۰۰۰,IRR\nعلي,5,IRR')).toEqual([
      { line: 2, user: '+989121234567', amount: '12000', currency: 'IRR' },
      { line: 3, user: 'علي', amount: '5', currency: 'IRR' },
    ]);
  });

  it('reads an optional telegram column, its digits folded; a blank cell is none (F-210)', () => {
    expect(parseBalanceFile('user,amount,currency,Telegram\nalice,5,IRR,۱۲۳ ۴۵۶\nbob,5,IRR,')).toEqual([
      { line: 2, user: 'alice', amount: '5', currency: 'IRR', telegram: '123456' },
      { line: 3, user: 'bob', amount: '5', currency: 'IRR' },
    ]);
  });

  it('refuses a file with a column missing, with no rows, or past the row cap', () => {
    expect(() => parseBalanceFile('user,amount\nalice,5')).toThrow(new BalanceFileRefused('csv_columns'));
    expect(() => parseBalanceFile('user,amount,currency\n\n')).toThrow(new BalanceFileRefused('csv_empty'));
    const many = ['user,amount,currency', ...Array.from({ length: 5001 }, (_, i) => `u${i},1,IRR`)].join('\n');
    expect(() => parseBalanceFile(many)).toThrow(new BalanceFileRefused('csv_too_many_rows'));
  });
});

describe('planBalanceRows', () => {
  const context = (over: Partial<BalancePlanContext> = {}): BalancePlanContext => ({
    peopleOf: new Map([
      ['alice', [ALICE]],
      ['+989121234567', [BOB]],
      ['shared', [ALICE, BOB]],
    ]),
    currencyOf: (userId) => (userId === BOB ? 'USD' : 'IRR'),
    placesOf: (code) => (code === 'USD' ? 2 : 0),
    ...over,
  });
  const row = (line: number, user: string, amount: string, currency: string) => ({ line, user, amount, currency });

  it('plans one credit per row it can name, and reports every other row with why', () => {
    const plan = planBalanceRows(
      [
        row(2, 'alice', '1000', 'IRR'),
        row(3, 'nobody', '5', 'IRR'),
        row(4, 'shared', '5', 'IRR'),
        row(5, 'alice', '7', 'IRR'),
        row(6, '+989121234567', '5', 'IRR'),
        row(7, '+989121234567', '5.001', 'USD'),
        row(8, '', '5', 'IRR'),
        row(9, 'alice', '0', 'IRR'),
      ],
      context(),
    );
    const skipOf = (line: number) => plan.items.find((i) => i.remoteIdentity === balanceItemKey(line))?.skipReason;
    expect(plan.items[0]).toEqual({
      remoteIdentity: balanceItemKey(2),
      sourceSnapshot: { line: 2, user: 'alice', amount: '1000', currency: 'IRR', userId: ALICE },
      plannedAction: MigrationItemAction.create,
      skipReason: null,
    });
    expect(skipOf(3)).toBe(MigrationSkipReason.unknown_user);
    expect(skipOf(4)).toBe(MigrationSkipReason.ambiguous_user);
    // One balance per person: a second row for them is a mistake in the file, not a second top-up.
    expect(skipOf(5)).toBe(MigrationSkipReason.duplicate);
    expect(skipOf(6)).toBe(MigrationSkipReason.currency_mismatch);
    // Finer than the wallet's currency (a cent has two places): refused, never rounded.
    expect(skipOf(7)).toBe(MigrationSkipReason.unreadable);
    expect(skipOf(8)).toBe(MigrationSkipReason.unreadable);
    expect(skipOf(9)).toBe(MigrationSkipReason.unreadable);
    expect(plan).toMatchObject({ plannedCreate: 1, plannedUpdate: 0, plannedSkip: 7, unaddressed: 0 });
  });

  it('keeps a row\'s Telegram id on its credit, and reports one that is no id unreadable (F-210)', () => {
    const plan = planBalanceRows([{ ...row(2, 'alice', '5', 'IRR'), telegram: '123456' }, { ...row(3, '+989121234567', '5', 'USD'), telegram: '@bob' }], context());
    expect(plan.items[0].sourceSnapshot).toEqual({ line: 2, user: 'alice', amount: '5', currency: 'IRR', userId: ALICE, telegramId: '123456' });
    expect(plan.items[1].skipReason).toBe(MigrationSkipReason.unreadable);
  });

  it('keys the items so the report reads in the file\'s order', () => {
    expect([balanceItemKey(10), balanceItemKey(9), balanceItemKey(100)].sort()).toEqual([balanceItemKey(9), balanceItemKey(10), balanceItemKey(100)]);
  });
});

describe('the commit and the rollback of one row', () => {
  const item = { id: 'item-2', remoteIdentity: balanceItemKey(2), sourceSnapshot: { line: 2, user: 'alice', amount: '1000', currency: 'IRR', userId: ALICE } };

  it('finds the person the dry run named, never makes one', () => {
    expect(csvPeopleOf([item]).made.get(item.remoteIdentity)).toEqual({ userId: ALICE, created: false });
  });

  it('claims the Telegram account a row named for its person through identity, and keeps the outcome on them (F-210)', async () => {
    const named = { ...item, sourceSnapshot: { ...item.sourceSnapshot, telegramId: '123456' } };
    const claim = vi.fn().mockResolvedValue({ links: [{ userId: ALICE, telegram: 'claimed' }] });
    const people = await withCsvTelegram(csvPeopleOf([named, { ...item, remoteIdentity: balanceItemKey(3) }]), claim);
    expect(claim).toHaveBeenCalledWith([{ userId: ALICE, chatId: '123456' }]);
    expect(people.made.get(named.remoteIdentity)).toEqual({ userId: ALICE, created: false, telegramId: '123456', telegram: 'claimed' });
  });

  it('asks identity nothing for a file with no Telegram column', async () => {
    const claim = vi.fn();
    await withCsvTelegram(csvPeopleOf([item]), claim);
    expect(claim).not.toHaveBeenCalled();
  });

  it('credits one ledger row naming the item — never an UPDATE on a balance', async () => {
    const credit = vi.fn().mockResolvedValue({ id: 'tx-1' });
    const tx = { user: { findFirst: vi.fn().mockResolvedValue({ id: ALICE }) }, wallet: { update: vi.fn(), updateMany: vi.fn() } };
    await creditBalanceRow(tx as never, { credit }, RUN, item, ALICE);
    expect(credit).toHaveBeenCalledWith(tx, { userId: ALICE, amount: new Prisma.Decimal('1000'), currencyCode: 'IRR', reasonType: WalletReasonType.migration_import, referenceId: 'item-2' });
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a wallet whose currency changed since the plan, rather than crediting it in the wrong one', async () => {
    const tx = { user: { findFirst: vi.fn().mockResolvedValue({ id: ALICE }) } };
    const credit = vi.fn().mockRejectedValue(new LedgerCurrencyMismatch(ALICE, 'USD', 'IRR'));
    await expect(creditBalanceRow(tx as never, { credit }, RUN, item, ALICE)).rejects.toThrow(new BalanceRowRefused('currency_mismatch'));
  });

  it('refuses a person deleted since the dry run', async () => {
    const tx = { user: { findFirst: vi.fn().mockResolvedValue(null) } };
    await expect(creditBalanceRow(tx as never, { credit: vi.fn() }, RUN, item, ALICE)).rejects.toThrow(new BalanceRowRefused('user_not_found'));
  });

  const credited = { id: 'tx-1', walletId: 'w-1', amount: new Prisma.Decimal('1000'), currencyCode: 'IRR', createdAt: new Date('2026-10-22T10:00:00Z'), wallet: { ownerUserId: ALICE } };
  const rollbackTx = (laterRows: number) => ({
    walletTransaction: { findFirst: vi.fn().mockResolvedValue(credited), count: vi.fn().mockResolvedValue(laterRows) },
  });

  it('writes the reversing debit of exactly what was credited', async () => {
    const debit = vi.fn().mockResolvedValue({});
    const tx = rollbackTx(0);
    await reverseBalanceRow(tx as never, { debit }, item);
    expect(tx.walletTransaction.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { reasonType: WalletReasonType.migration_import, referenceId: 'item-2', direction: LedgerDirection.credit } }));
    expect(debit).toHaveBeenCalledWith(tx, { userId: ALICE, amount: credited.amount, currencyCode: 'IRR', reasonType: WalletReasonType.migration_import, referenceId: 'item-2' });
  });

  it('keeps the money of a wallet that moved since, or that cannot cover it', async () => {
    const debit = vi.fn();
    await expect(reverseBalanceRow(rollbackTx(1) as never, { debit }, item)).rejects.toThrow(new BalanceRowRefused('wallet_used'));
    expect(debit).not.toHaveBeenCalled();
    const held = vi.fn().mockRejectedValue(new InsufficientFunds(ALICE));
    await expect(reverseBalanceRow(rollbackTx(0) as never, { debit: held }, item)).rejects.toThrow(new BalanceRowRefused('wallet_used'));
  });
});
