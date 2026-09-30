import { Prisma, WalletReasonType } from '@prisma/client';
import { METER_KEYS } from '@txnet-backend/shared-core';

import { REFUND_REASONS, SALE_REASONS } from '../revenue/reseller-revenue.service';
import { InsufficientFunds } from '../wallet/wallet-ledger.service';
import { UsageRefundService } from './usage-refund';
import { UsageSettlementRefused, UsageSettlementService, capturable, blockFor } from './usage-settlement';

/**
 * Rating and settlement (F-118-g, ADR-0105 (5)(6)(11)).
 *
 * The invariant this file holds: **a unit is charged once, never more than
 * its price, and never served unfunded.** Rating reads `consumed − billed`;
 * the ledger gets whole cents only, rounded in the buyer's favour, and the
 * `billed` cursor advances only by the units those cents cover — so what is
 * rounded away is carried, not lost and not charged twice. Prepaid debits a
 * block before its units are served; postpaid holds money and captures what
 * was measured, before every re-top and at close.
 */
const D = (v: string | number) => new Prisma.Decimal(v);
const n = (v: number) => BigInt(v);

const GRANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const METER_ID = '33333333-3333-4333-8333-333333333333';
const KEY = 'sms.message';

type MeterRow = {
  id: string;
  tenantId: string;
  grantId: string;
  meterKey: string;
  unitSize: bigint;
  unitPrice: Prisma.Decimal;
  currencyCode: string;
  mode: 'prepaid' | 'postpaid';
  includedQuantity: bigint;
  afterIncluded: 'stop' | 'metered';
  consumed: bigint;
  billed: bigint;
  funded: bigint;
};

function world(meter: Partial<MeterRow> = {}, opts: { balance?: string; status?: string } = {}) {
  const grant = { id: GRANT, userId: USER, tenantId: 't1', status: opts.status ?? 'active' };
  const row: MeterRow = {
    id: METER_ID,
    tenantId: 't1',
    grantId: GRANT,
    meterKey: KEY,
    // $0.003 a message.
    unitSize: n(1),
    unitPrice: D('0.003'),
    currencyCode: 'USD',
    mode: 'postpaid',
    includedQuantity: n(0),
    afterIncluded: 'metered',
    consumed: n(0),
    billed: n(0),
    funded: n(0),
    ...meter,
  };
  const wallet = { id: 'w1', ownerUserId: USER, currencyCode: 'USD', cachedBalance: D(opts.balance ?? '10'), heldAmount: D(0) };
  const holds = new Map<string, Prisma.Decimal>();
  const calls: string[] = [];
  const ledger: Array<{ direction: 'debit' | 'credit'; amount: string; reasonType: WalletReasonType; referenceId?: string }> = [];

  const tx = {
    $executeRaw: async () => 0,
    grant: { findUnique: async () => ({ ...grant }) },
    grantMeter: {
      findUnique: async ({ where }: { where: { grantId_meterKey: { grantId: string; meterKey: string } } }) =>
        where.grantId_meterKey.meterKey === row.meterKey ? { ...row } : null,
      findMany: async () => [{ ...row }],
      updateMany: async ({ where, data }: { where: Partial<MeterRow>; data: Partial<MeterRow> }) => {
        const same = (Object.keys(where) as (keyof MeterRow)[]).every((k) => where[k] === row[k]);
        if (!same) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    wallet: { findUnique: async () => ({ ...wallet }) },
    walletHold: {
      findFirst: async ({ where }: { where: { ownerRef: string } }) => {
        const amount = holds.get(where.ownerRef);
        return amount ? { id: 'h1', ownerRef: where.ownerRef, amount } : null;
      },
    },
  } as unknown as Prisma.TransactionClient;

  const free = () => wallet.cachedBalance.minus(wallet.heldAmount);
  const ledgerFake = {
    debit: async (_tx: unknown, e: { amount: Prisma.Decimal; reasonType: WalletReasonType; referenceId?: string }) => {
      if (free().lt(e.amount)) throw new InsufficientFunds(USER);
      wallet.cachedBalance = wallet.cachedBalance.minus(e.amount);
      ledger.push({ direction: 'debit', amount: e.amount.toFixed(2), reasonType: e.reasonType, referenceId: e.referenceId });
      calls.push('debit');
      return { id: `tx-${ledger.length}`, balanceAfter: wallet.cachedBalance };
    },
    credit: async (_tx: unknown, e: { amount: Prisma.Decimal; reasonType: WalletReasonType; referenceId?: string }) => {
      wallet.cachedBalance = wallet.cachedBalance.plus(e.amount);
      ledger.push({ direction: 'credit', amount: e.amount.toFixed(2), reasonType: e.reasonType, referenceId: e.referenceId });
      calls.push('credit');
      return { id: `tx-${ledger.length}`, balanceAfter: wallet.cachedBalance };
    },
  };
  const holdFake = {
    hold: async (_tx: unknown, e: { ownerRef: string; amount: Prisma.Decimal }) => {
      if (free().lt(e.amount)) throw new InsufficientFunds(USER);
      holds.set(e.ownerRef, (holds.get(e.ownerRef) ?? D(0)).plus(e.amount));
      wallet.heldAmount = wallet.heldAmount.plus(e.amount);
      calls.push(`hold ${e.amount.toFixed(2)}`);
    },
    capture: async (_tx: unknown, e: { ownerRef: string; amount: Prisma.Decimal; reasonType: WalletReasonType; referenceId?: string }) => {
      holds.set(e.ownerRef, holds.get(e.ownerRef)!.minus(e.amount));
      wallet.heldAmount = wallet.heldAmount.minus(e.amount);
      wallet.cachedBalance = wallet.cachedBalance.minus(e.amount);
      ledger.push({ direction: 'debit', amount: e.amount.toFixed(2), reasonType: e.reasonType, referenceId: e.referenceId });
      calls.push(`capture ${e.amount.toFixed(2)}`);
      return { id: `tx-${ledger.length}` };
    },
    release: async (_tx: unknown, e: { ownerRef: string; amount?: Prisma.Decimal }) => {
      const all = holds.get(e.ownerRef)!;
      wallet.heldAmount = wallet.heldAmount.minus(e.amount ?? all);
      if (e.amount) holds.set(e.ownerRef, all.minus(e.amount));
      else holds.delete(e.ownerRef);
      calls.push(`release ${(e.amount ?? all).toFixed(2)}`);
    },
  };
  const crossTenant = { grantMeter: { findMany: async () => [{ id: row.id, grantId: row.grantId, meterKey: row.meterKey, tenantId: 't1', consumed: row.consumed, billed: row.billed, includedQuantity: row.includedQuantity }] } };
  const prisma = { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) };
  const refunds = new UsageRefundService(ledgerFake as never);
  // Open per-use tokens are the door's own suite (`usage-door.spec.ts`); here none is open.
  const door = { cancelOpen: async () => 0 };
  const service = new UsageSettlementService(prisma as never, crossTenant as never, ledgerFake as never, holdFake as never, refunds, door as never);
  return { service, tx, row, wallet, holds, calls, ledger };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof UsageSettlementRefused) return e.reason;
    throw e;
  }
  throw new Error('expected a refusal');
};

describe('usage settlement arithmetic (F-118-g)', () => {
  const meter = { unitSize: n(1), unitPrice: D('0.003'), includedQuantity: n(0) };

  it('rounds a capture down to a whole cent and advances the cursor only by the units it covers', () => {
    // 7 messages are 2.1c: 2c is charged, and 2c covers 6 of them — the 7th is carried, not dropped.
    expect(capturable(meter, n(0), n(7))).toEqual({ cents: n(2), billedTo: n(6) });
    // Under a cent is nothing yet, and nothing moves.
    expect(capturable(meter, n(0), n(3))).toEqual({ cents: n(0), billedTo: n(0) });
  });

  it('rounds a final capture up to a whole cent, so a closed meter owes nothing under a cent (F-118-al)', () => {
    // 7 messages are 2.1c: 3c charged, all 7 billed — nothing is left to forgive.
    expect(capturable(meter, n(0), n(7), undefined, 'up')).toEqual({ cents: n(3), billedTo: n(7) });
    expect(capturable(meter, n(0), n(1), undefined, 'up')).toEqual({ cents: n(1), billedTo: n(1) });
    // Nothing used is nothing charged; a short hold still caps it.
    expect(capturable(meter, n(5), n(5), undefined, 'up')).toEqual({ cents: n(0), billedTo: n(5) });
    expect(capturable(meter, n(0), n(7), n(2), 'up')).toEqual({ cents: n(2), billedTo: n(6) });
  });

  it('never charges the included quantity', () => {
    const plan = { ...meter, includedQuantity: n(100) };
    expect(capturable(plan, n(0), n(100))).toEqual({ cents: n(0), billedTo: n(0) });
    // The cursor jumps the free part; 10 paid messages are 3c.
    expect(capturable(plan, n(0), n(110))).toEqual({ cents: n(3), billedTo: n(110) });
  });

  it('prices a block up to a whole cent and gives back only what those cents buy', () => {
    // 1000 messages at $0.003 = $3.00 exactly.
    expect(blockFor(meter, n(1000), D('50'))).toEqual({ cents: n(300), units: n(1000) });
    // 1001 = 300.3c, rounded up to 301c, which buys 1003 whole messages.
    expect(blockFor(meter, n(1001), D('50'))).toEqual({ cents: n(301), units: n(1003) });
    // A short balance buys the largest block it can.
    expect(blockFor(meter, n(1000), D('1.005'))).toEqual({ cents: n(100), units: n(333) });
  });

  it('refuses a price finer than the column, and a free unit past the plan', () => {
    expect(() => blockFor({ ...meter, unitPrice: D('0.000000001') }, n(1), D(1))).toThrow(UsageSettlementRefused);
    expect(() => blockFor({ ...meter, unitPrice: D(0) }, n(1), D(1))).toThrow(UsageSettlementRefused);
  });
});

describe('prepaid: a block is debited before it is served (ADR-0072)', () => {
  it('debits usage_charge and moves funded and billed together, past the included part', async () => {
    const w = world({ mode: 'prepaid', includedQuantity: n(50) });
    const out = await w.service.buyBlock(w.tx, { grantId: GRANT, meterKey: KEY, targetUnits: n(1000) });
    expect(out.amount.toFixed(2)).toBe('3.00');
    expect(w.ledger).toEqual([{ direction: 'debit', amount: '3.00', reasonType: WalletReasonType.usage_charge, referenceId: GRANT }]);
    expect(w.row.funded).toBe(n(1050));
    expect(w.row.billed).toBe(n(1050));
  });

  it('refuses under one cent, a stop card, a postpaid meter and a closed Grant — writing nothing', async () => {
    const broke = world({ mode: 'prepaid' }, { balance: '0.009' });
    expect(await refusal(broke.service.buyBlock(broke.tx, { grantId: GRANT, meterKey: KEY, targetUnits: n(10) }))).toBe('insufficient_funds');
    const stop = world({ mode: 'prepaid', afterIncluded: 'stop' });
    expect(await refusal(stop.service.buyBlock(stop.tx, { grantId: GRANT, meterKey: KEY, targetUnits: n(10) }))).toBe('not_metered_past_included');
    const post = world({ mode: 'postpaid' });
    expect(await refusal(post.service.buyBlock(post.tx, { grantId: GRANT, meterKey: KEY, targetUnits: n(10) }))).toBe('wrong_mode');
    const closed = world({ mode: 'prepaid' }, { status: 'expired' });
    expect(await refusal(closed.service.buyBlock(closed.tx, { grantId: GRANT, meterKey: KEY, targetUnits: n(10) }))).toBe('grant_not_active');
    for (const x of [broke, stop, post, closed]) expect(x.ledger).toEqual([]);
  });

  it('gives the unserved remainder back at close as usage_refund, rounded down, once', async () => {
    // Bought 1000, served 333: 667 x 0.3c = 200.1c, 200c back.
    const w = world({ mode: 'prepaid', funded: n(1000), billed: n(1000), consumed: n(333) });
    await w.service.settleAtClose(w.tx, { grantId: GRANT });
    expect(w.ledger).toEqual([{ direction: 'credit', amount: '2.00', reasonType: WalletReasonType.usage_refund, referenceId: GRANT }]);
    expect(w.row.billed).toBe(n(333));
    // A second close finds nothing to give.
    await w.service.settleAtClose(w.tx, { grantId: GRANT });
    expect(w.ledger).toHaveLength(1);
  });
  it("keeps the remainder when the admin's delete answered no refund (F-118-u)", async () => {
    const w = world({ mode: 'prepaid', funded: n(1000), billed: n(1000), consumed: n(333) });
    await w.service.settleAtClose(w.tx, { grantId: GRANT, refund: false });
    expect(w.ledger).toEqual([]);
    expect(w.row.billed).toBe(n(1000));
  });
});

describe('postpaid: held, then captured (ADR-0105 (6))', () => {
  it('holds the target rounded up and funds what the hold covers', async () => {
    const w = world();
    const out = await w.service.topUp(w.tx, { grantId: GRANT, meterKey: KEY, targetUnits: n(1001) });
    expect(w.calls).toEqual(['hold 3.01']);
    expect(out.held.toFixed(2)).toBe('3.01');
    expect(w.row.funded).toBe(n(1003));
    expect(w.ledger).toEqual([]);
  });

  it('captures what was measured before it re-tops, as usage_charge', async () => {
    const w = world({ funded: n(1000), consumed: n(700) });
    w.holds.set(METER_ID, D('3.00'));
    w.wallet.heldAmount = D('3.00');
    await w.service.topUp(w.tx, { grantId: GRANT, meterKey: KEY, targetUnits: n(1000) });
    // 700 messages = $2.10 captured first, then the hold back up to $3.00.
    expect(w.calls).toEqual(['capture 2.10', 'hold 2.10']);
    expect(w.ledger).toEqual([{ direction: 'debit', amount: '2.10', reasonType: WalletReasonType.usage_charge, referenceId: GRANT }]);
    expect(w.row.billed).toBe(n(700));
    expect(w.row.funded).toBe(n(1700));
  });

  it('holds less on a short balance, and refuses only under one cent', async () => {
    const short = world({}, { balance: '1.00' });
    await short.service.topUp(short.tx, { grantId: GRANT, meterKey: KEY, targetUnits: n(1000) });
    expect(short.calls).toEqual(['hold 1.00']);
    expect(short.row.funded).toBe(n(333));
    const none = world({}, { balance: '0.009' });
    expect(await refusal(none.service.topUp(none.tx, { grantId: GRANT, meterKey: KEY, targetUnits: n(10) }))).toBe('insufficient_funds');
  });

  it('never captures more than the hold: an overrun waits for the next hold', async () => {
    const w = world({ funded: n(100), consumed: n(150) });
    w.holds.set(METER_ID, D('0.30'));
    w.wallet.heldAmount = D('0.30');
    await w.service.capture(w.tx, { grantId: GRANT, meterKey: KEY });
    expect(w.ledger.map((l) => l.amount)).toEqual(['0.30']);
    expect(w.row.billed).toBe(n(100));
  });

  it('at a final close captures the rest rounded up to a cent, and releases what is left (F-118-al)', async () => {
    const w = world({ funded: n(1000), consumed: n(501) }, { status: 'expired' });
    w.holds.set(METER_ID, D('3.00'));
    w.wallet.heldAmount = D('3.00');
    await w.service.settleAtClose(w.tx, { grantId: GRANT });
    // 501 = 150.3c: 151c captured, all 501 billed — a reopened Grant gets no dust for free.
    expect(w.calls).toEqual(['capture 1.51', 'release 1.49']);
    expect(w.row.billed).toBe(n(501));
    expect(w.row.funded).toBe(n(501));
    expect(w.holds.has(METER_ID)).toBe(false);
  });

  it('a close of a Grant that may come back rounds down and carries the dust to its next capture', async () => {
    const w = world({ funded: n(1000), consumed: n(501) }, { status: 'suspended' });
    w.holds.set(METER_ID, D('3.00'));
    w.wallet.heldAmount = D('3.00');
    await w.service.settleAtClose(w.tx, { grantId: GRANT });
    expect(w.calls).toEqual(['capture 1.50', 'release 1.50']);
    expect(w.row.billed).toBe(n(500));
  });

  it('a final close with nothing used past the last capture charges nothing', async () => {
    const w = world({ funded: n(1000), consumed: n(500), billed: n(500) }, { status: 'cancelled' });
    w.holds.set(METER_ID, D('3.00'));
    w.wallet.heldAmount = D('3.00');
    await w.service.settleAtClose(w.tx, { grantId: GRANT });
    expect(w.calls).toEqual(['release 3.00']);
    expect(w.ledger).toEqual([]);
  });

  it('at close without a refund still captures what was used and releases the hold: held money is never kept (F-118-u)', async () => {
    const w = world({ funded: n(1000), consumed: n(500) });
    w.holds.set(METER_ID, D('3.00'));
    w.wallet.heldAmount = D('3.00');
    await w.service.settleAtClose(w.tx, { grantId: GRANT, refund: false });
    expect(w.calls).toEqual(['capture 1.50', 'release 1.50']);
    expect(w.holds.has(METER_ID)).toBe(false);
  });

  it('the hourly sweep captures and restores the hold to what it was', async () => {
    const w = world({ funded: n(1000), consumed: n(400) });
    w.holds.set(METER_ID, D('3.00'));
    w.wallet.heldAmount = D('3.00');
    const out = await w.service.captureDue();
    expect(out).toEqual({ scanned: 1, captured: 1, errors: 0 });
    expect(w.calls).toEqual(['capture 1.20', 'hold 1.20']);
  });
});

describe('boundaries', () => {
  it('leaves a prepaid vpn.traffic on its byte engine (F-118-k moved only postpaid here)', async () => {
    const w = world({ meterKey: METER_KEYS.vpnTraffic, mode: 'prepaid' });
    expect(await refusal(w.service.capture(w.tx, { grantId: GRANT, meterKey: METER_KEYS.vpnTraffic }))).toBe('meter_on_its_own_path');
  });

  it('counts usage_charge as a sale and usage_refund as undoing one', () => {
    expect(SALE_REASONS).toContain(WalletReasonType.usage_charge);
    expect(REFUND_REASONS).toContain(WalletReasonType.usage_refund);
  });
});
