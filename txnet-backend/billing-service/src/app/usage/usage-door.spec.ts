import { Prisma, TenantBillingReasonType, WalletReasonType } from '@prisma/client';
import { METER_KEYS } from '@txnet-backend/shared-core';

import { InsufficientFunds } from '../wallet/wallet-ledger.service';
import { UsageRefundService } from './usage-refund';
import { UsageDoorRefused, UsageDoorService } from './usage-door';

/**
 * The per-use door (F-118-h, ADR-0105 decision 7).
 *
 * The invariant this file holds: **unfunded work is refused before it is
 * done, and money leaves only for what was used.** `authorize` debits
 * (prepaid) or holds (postpaid) before the work — on a reseller's Grant, the
 * wholesale units on its billing wallet first — and a refusal writes nothing.
 * `commit` records the actual use; `commit`, `cancel` and expiry give back
 * what no open token still needs.
 */
const D = (v: string | number) => new Prisma.Decimal(v);
const n = (v: number) => BigInt(v);

const GRANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const METER_ID = '33333333-3333-4333-8333-333333333333';
const RESELLER = '44444444-4444-4444-8444-444444444444';
const KEY = METER_KEYS.configRegenerate;
const NOW = new Date('2026-09-29T12:00:00Z');

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
  wholesalePayerTenantId: string | null;
  wholesaleRateId: string | null;
  wholesaleUnitSize: bigint | null;
  wholesaleUnitPrice: Prisma.Decimal | null;
  wholesaleCurrencyCode: string | null;
  wholesaleBilled: bigint;
};

type Token = {
  id: string;
  tenantId: string;
  grantId: string;
  meterKey: string;
  idempotencyKey: string;
  quantity: bigint;
  status: 'open' | 'committed' | 'cancelled' | 'expired';
  boughtUnits: bigint;
  heldAmount: Prisma.Decimal;
  wholesaleUnits: bigint;
  committedQuantity: bigint | null;
  expiresAt: Date;
  settledAt: Date | null;
};

const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'lte' in (v as object)) return (row[k] as Date).getTime() <= ((v as { lte: Date }).lte as Date).getTime();
    return row[k] === v;
  });

function world(meter: Partial<MeterRow> = {}, opts: { balance?: string; reseller?: string; status?: string } = {}) {
  const grant = { id: GRANT, userId: USER, tenantId: RESELLER, status: opts.status ?? 'active' };
  const row: MeterRow = {
    id: METER_ID,
    tenantId: RESELLER,
    grantId: GRANT,
    meterKey: KEY,
    // 10.00 a regenerate.
    unitSize: n(1),
    unitPrice: D('10'),
    currencyCode: 'USD',
    mode: 'prepaid',
    includedQuantity: n(0),
    afterIncluded: 'metered',
    consumed: n(0),
    billed: n(0),
    funded: n(0),
    wholesalePayerTenantId: null,
    wholesaleRateId: null,
    wholesaleUnitSize: null,
    wholesaleUnitPrice: null,
    wholesaleCurrencyCode: null,
    wholesaleBilled: n(0),
    ...meter,
  };
  const wallet = { id: 'w1', ownerUserId: USER, currencyCode: 'USD', cachedBalance: D(opts.balance ?? '100'), heldAmount: D(0) };
  const resellerWallet = opts.reseller === undefined ? null : { tenantId: RESELLER, cachedBalance: D(opts.reseller) };
  const holds = new Map<string, Prisma.Decimal>();
  const tokens: Token[] = [];
  const events: Array<{ quantity: bigint; idempotencyKey: string }> = [];
  const ledger: Array<{ direction: 'debit' | 'credit'; amount: string; reasonType: WalletReasonType; referenceId?: string }> = [];
  const resellerLedger: Array<{ direction: 'debit' | 'credit'; amount: string; reasonType: TenantBillingReasonType; referenceId?: string }> = [];

  const tx = {
    $executeRaw: async () => 0,
    grant: { findUnique: async () => ({ ...grant }) },
    grantMeter: {
      findUnique: async ({ where }: { where: { grantId_meterKey: { grantId: string; meterKey: string } } }) =>
        where.grantId_meterKey.meterKey === row.meterKey ? { ...row } : null,
      update: async ({ data }: { data: { consumed: { increment: bigint } } }) => {
        row.consumed += data.consumed.increment;
        return { consumed: row.consumed };
      },
      updateMany: async ({ where, data }: { where: Partial<MeterRow>; data: Partial<MeterRow> }) => {
        if (!matches(row, where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    usageEvent: {
      createMany: async ({ data }: { data: Array<{ quantity: bigint; idempotencyKey: string }> }) => {
        if (events.some((e) => e.idempotencyKey === data[0].idempotencyKey)) return { count: 0 };
        events.push(data[0]);
        return { count: 1 };
      },
    },
    usageAuthorization: {
      findUnique: async ({ where }: { where: { id?: string; grantId_meterKey_idempotencyKey?: { idempotencyKey: string } } }) => {
        const t = where.id ? tokens.find((x) => x.id === where.id) : tokens.find((x) => x.idempotencyKey === where.grantId_meterKey_idempotencyKey!.idempotencyKey);
        return t ? { ...t } : null;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => tokens.filter((t) => matches(t, where)).map((t) => ({ ...t })),
      create: async ({ data }: { data: Partial<Token> & { id: string } }) => {
        const t: Token = { status: 'open', boughtUnits: n(0), heldAmount: D(0), wholesaleUnits: n(0), committedQuantity: null, settledAt: null, ...data } as Token;
        tokens.push(t);
        return { ...t };
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Token> }) => {
        const t = tokens.find((x) => matches(x, where));
        if (!t) return { count: 0 };
        Object.assign(t, data);
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
    tenantBillingWallet: { findUnique: async () => (resellerWallet ? { ...resellerWallet } : null) },
  } as unknown as Prisma.TransactionClient;

  const free = () => wallet.cachedBalance.minus(wallet.heldAmount);
  const ledgerFake = {
    debit: async (_tx: unknown, e: { amount: Prisma.Decimal; reasonType: WalletReasonType; referenceId?: string }) => {
      if (free().lt(e.amount)) throw new InsufficientFunds(USER);
      wallet.cachedBalance = wallet.cachedBalance.minus(e.amount);
      ledger.push({ direction: 'debit', amount: e.amount.toFixed(2), reasonType: e.reasonType, referenceId: e.referenceId });
      return { id: `tx-${ledger.length}` };
    },
    credit: async (_tx: unknown, e: { amount: Prisma.Decimal; reasonType: WalletReasonType; referenceId?: string }) => {
      wallet.cachedBalance = wallet.cachedBalance.plus(e.amount);
      ledger.push({ direction: 'credit', amount: e.amount.toFixed(2), reasonType: e.reasonType, referenceId: e.referenceId });
      return { id: `tx-${ledger.length}` };
    },
  };
  const holdFake = {
    hold: async (_tx: unknown, e: { ownerRef: string; amount: Prisma.Decimal }) => {
      if (free().lt(e.amount)) throw new InsufficientFunds(USER);
      holds.set(e.ownerRef, (holds.get(e.ownerRef) ?? D(0)).plus(e.amount));
      wallet.heldAmount = wallet.heldAmount.plus(e.amount);
    },
    capture: async (_tx: unknown, e: { ownerRef: string; amount: Prisma.Decimal; reasonType: WalletReasonType; referenceId?: string }) => {
      holds.set(e.ownerRef, holds.get(e.ownerRef)!.minus(e.amount));
      wallet.heldAmount = wallet.heldAmount.minus(e.amount);
      wallet.cachedBalance = wallet.cachedBalance.minus(e.amount);
      ledger.push({ direction: 'debit', amount: e.amount.toFixed(2), reasonType: e.reasonType, referenceId: e.referenceId });
      return { id: `tx-${ledger.length}` };
    },
    release: async (_tx: unknown, e: { ownerRef: string; amount?: Prisma.Decimal }) => {
      const all = holds.get(e.ownerRef)!;
      wallet.heldAmount = wallet.heldAmount.minus(e.amount ?? all);
      if (e.amount && !e.amount.eq(all)) holds.set(e.ownerRef, all.minus(e.amount));
      else holds.delete(e.ownerRef);
    },
  };
  const tenantLedgerFake = {
    debit: async (_tx: unknown, e: { amount: Prisma.Decimal; reasonType: TenantBillingReasonType; referenceId?: string }) => {
      resellerWallet!.cachedBalance = resellerWallet!.cachedBalance.minus(e.amount);
      resellerLedger.push({ direction: 'debit', amount: e.amount.toFixed(2), reasonType: e.reasonType, referenceId: e.referenceId });
      return { id: `rt-${resellerLedger.length}` };
    },
    credit: async (_tx: unknown, e: { amount: Prisma.Decimal; reasonType: TenantBillingReasonType; referenceId?: string }) => {
      resellerWallet!.cachedBalance = resellerWallet!.cachedBalance.plus(e.amount);
      resellerLedger.push({ direction: 'credit', amount: e.amount.toFixed(2), reasonType: e.reasonType, referenceId: e.referenceId });
      return { id: `rt-${resellerLedger.length}` };
    },
  };
  const crossTenant = {
    usageAuthorization: {
      findMany: async () => tokens.filter((t) => t.status === 'open' && t.expiresAt.getTime() <= NOW.getTime()).map((t) => ({ id: t.id, tenantId: t.tenantId })),
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) };
  const refunds = new UsageRefundService(ledgerFake as never);
  const door = new UsageDoorService(prisma as never, crossTenant as never, ledgerFake as never, holdFake as never, refunds, tenantLedgerFake as never);
  return { door, tx, row, wallet, resellerWallet, holds, tokens, events, ledger, resellerLedger };
}

const WHOLESALE = {
  wholesalePayerTenantId: RESELLER,
  wholesaleRateId: '55555555-5555-4555-8555-555555555555',
  wholesaleUnitSize: n(1),
  wholesaleUnitPrice: D('4'),
  wholesaleCurrencyCode: 'USD',
};

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof UsageDoorRefused) return e.reason;
    throw e;
  }
  throw new Error('expected a refusal');
};

const ask = (door: UsageDoorService, tx: Prisma.TransactionClient, key = 'k1', quantity = 1) =>
  door.authorize(tx, { grantId: GRANT, meterKey: KEY, quantity: n(quantity), key }, NOW);

describe('UsageDoorService (F-118-h)', () => {
  describe('prepaid', () => {
    it('debits the price before the work, and a commit records the use against it', async () => {
      const w = world();
      const auth = await ask(w.door, w.tx);
      expect(w.ledger).toEqual([{ direction: 'debit', amount: '10.00', reasonType: WalletReasonType.usage_charge, referenceId: GRANT }]);
      expect(w.row).toMatchObject({ funded: n(1), billed: n(1), consumed: n(0) });

      await w.door.commit(w.tx, { token: auth.token, quantity: n(1) }, NOW);
      expect(w.events).toEqual([expect.objectContaining({ quantity: n(1), idempotencyKey: auth.token })]);
      expect(w.row).toMatchObject({ consumed: n(1), billed: n(1), funded: n(1) });
      expect(w.ledger).toHaveLength(1);
      expect(w.tokens[0]).toMatchObject({ status: 'committed', committedQuantity: n(1) });
    });

    it('a cancel gives the whole debit back as usage_refund, and nothing is recorded', async () => {
      const w = world();
      const auth = await ask(w.door, w.tx);
      await w.door.cancel(w.tx, { token: auth.token }, NOW);
      expect(w.ledger.map((l) => `${l.direction} ${l.amount} ${l.reasonType}`)).toEqual(['debit 10.00 usage_charge', 'credit 10.00 usage_refund']);
      expect(w.row).toMatchObject({ consumed: n(0), billed: n(0), funded: n(0) });
      expect(w.events).toEqual([]);
      expect(w.wallet.cachedBalance.toFixed(2)).toBe('100.00');
    });

    it('the included quantity is free; the first unit past it is charged', async () => {
      const w = world({ includedQuantity: n(2) });
      for (const key of ['a', 'b']) {
        const auth = await ask(w.door, w.tx, key);
        await w.door.commit(w.tx, { token: auth.token, quantity: n(1) }, NOW);
      }
      expect(w.ledger).toEqual([]);
      await ask(w.door, w.tx, 'c');
      expect(w.ledger.map((l) => l.amount)).toEqual(['10.00']);
    });

    it('an open token reserves its units: a second one is charged too', async () => {
      const w = world({ includedQuantity: n(1) });
      await ask(w.door, w.tx, 'a');
      await ask(w.door, w.tx, 'b');
      expect(w.ledger.map((l) => l.amount)).toEqual(['10.00']);
    });
  });

  describe('refused, and nothing written', () => {
    it('a stop card past its included quantity', async () => {
      const w = world({ includedQuantity: n(1), consumed: n(1), afterIncluded: 'stop' });
      expect(await refusal(ask(w.door, w.tx))).toBe('not_metered_past_included');
      expect(w.tokens).toEqual([]);
    });

    it('a balance short of the whole price', async () => {
      const w = world({}, { balance: '9.99' });
      expect(await refusal(ask(w.door, w.tx))).toBe('insufficient_funds');
      expect(w.tokens).toEqual([]);
      expect(w.ledger).toEqual([]);
      expect(w.row).toMatchObject({ funded: n(0), billed: n(0) });
    });

    it('a Grant that is not active', async () => {
      const w = world({}, { status: 'suspended' });
      expect(await refusal(ask(w.door, w.tx))).toBe('grant_not_active');
    });

    it('a meter the door does not serve', async () => {
      const w = world({ meterKey: METER_KEYS.vpnTraffic });
      expect(await refusal(w.door.authorize(w.tx, { grantId: GRANT, meterKey: METER_KEYS.vpnTraffic, quantity: n(1), key: 'k' }, NOW))).toBe('meter_not_on_door');
    });
  });

  describe('postpaid', () => {
    it('holds the price before the work; a commit captures it and nothing stays held', async () => {
      const w = world({ mode: 'postpaid' });
      const auth = await ask(w.door, w.tx);
      expect(w.holds.get(METER_ID)?.toFixed(2)).toBe('10.00');
      expect(w.row.funded).toBe(n(1));
      expect(w.ledger).toEqual([]);

      await w.door.commit(w.tx, { token: auth.token, quantity: n(1) }, NOW);
      expect(w.ledger).toEqual([{ direction: 'debit', amount: '10.00', reasonType: WalletReasonType.usage_charge, referenceId: GRANT }]);
      expect(w.holds.has(METER_ID)).toBe(false);
      expect(w.wallet.heldAmount.toFixed(2)).toBe('0.00');
      expect(w.row).toMatchObject({ consumed: n(1), billed: n(1), funded: n(1) });
    });

    it('a cancel releases the hold and charges nothing', async () => {
      const w = world({ mode: 'postpaid' });
      const auth = await ask(w.door, w.tx);
      await w.door.cancel(w.tx, { token: auth.token }, NOW);
      expect(w.ledger).toEqual([]);
      expect(w.holds.has(METER_ID)).toBe(false);
      expect(w.row.funded).toBe(n(0));
    });

    it('a free balance short of the price holds nothing', async () => {
      const w = world({ mode: 'postpaid' }, { balance: '5' });
      expect(await refusal(ask(w.door, w.tx))).toBe('insufficient_funds');
      expect(w.holds.size).toBe(0);
    });
  });

  describe("a reseller's Grant: the wholesale leg", () => {
    it("buys the units on the reseller's billing wallet first, then charges the user", async () => {
      const w = world(WHOLESALE, { reseller: '50' });
      const auth = await ask(w.door, w.tx);
      expect(w.resellerLedger).toEqual([{ direction: 'debit', amount: '4.00', reasonType: TenantBillingReasonType.metered_usage_charge, referenceId: auth.token }]);
      expect(w.row.wholesaleBilled).toBe(n(1));
      expect(w.ledger.map((l) => l.amount)).toEqual(['10.00']);
    });

    it('a reseller at zero refuses the work, and the user is not charged', async () => {
      const w = world(WHOLESALE, { reseller: '3.99' });
      expect(await refusal(ask(w.door, w.tx))).toBe('wholesale_unfunded');
      expect(w.ledger).toEqual([]);
      expect(w.resellerLedger).toEqual([]);
      expect(w.tokens).toEqual([]);
    });

    it("charges the reseller for a unit its user got free: the package rate has no included part", async () => {
      const w = world({ ...WHOLESALE, includedQuantity: n(5) }, { reseller: '50' });
      await ask(w.door, w.tx);
      expect(w.resellerLedger.map((l) => l.amount)).toEqual(['4.00']);
      expect(w.ledger).toEqual([]);
    });

    it('a cancel gives the wholesale units back as metered_usage_refund', async () => {
      const w = world(WHOLESALE, { reseller: '50' });
      const auth = await ask(w.door, w.tx);
      await w.door.cancel(w.tx, { token: auth.token }, NOW);
      expect(w.resellerLedger.map((l) => `${l.direction} ${l.amount} ${l.reasonType} ${l.referenceId === auth.token}`)).toEqual([
        'debit 4.00 metered_usage_charge true',
        'credit 4.00 metered_usage_refund true',
      ]);
      expect(w.row.wholesaleBilled).toBe(n(0));
      expect(w.resellerWallet!.cachedBalance.toFixed(2)).toBe('50.00');
    });
  });

  describe('the token', () => {
    it('the same key answers the same token and charges once; another quantity is key_reused', async () => {
      const w = world();
      const a = await ask(w.door, w.tx, 'same');
      const b = await ask(w.door, w.tx, 'same');
      expect(b.token).toBe(a.token);
      expect(w.ledger).toHaveLength(1);
      expect(await refusal(ask(w.door, w.tx, 'same', 2))).toBe('key_reused');
    });

    it('a commit above what was authorized is refused; a second identical commit changes nothing', async () => {
      const w = world();
      const auth = await ask(w.door, w.tx);
      expect(await refusal(w.door.commit(w.tx, { token: auth.token, quantity: n(2) }, NOW))).toBe('over_authorized');
      await w.door.commit(w.tx, { token: auth.token, quantity: n(1) }, NOW);
      await w.door.commit(w.tx, { token: auth.token, quantity: n(1) }, NOW);
      expect(w.events).toHaveLength(1);
      expect(w.row.consumed).toBe(n(1));
    });

    it('a cancelled token cannot be committed, and an expired one is refused', async () => {
      const w = world();
      const a = await ask(w.door, w.tx, 'a');
      await w.door.cancel(w.tx, { token: a.token }, NOW);
      expect(await refusal(w.door.commit(w.tx, { token: a.token, quantity: n(1) }, NOW))).toBe('token_settled');

      const b = await w.door.authorize(w.tx, { grantId: GRANT, meterKey: KEY, quantity: n(1), key: 'b', ttlMs: 1000 }, NOW);
      expect(await refusal(w.door.commit(w.tx, { token: b.token, quantity: n(1) }, new Date(NOW.getTime() + 1000)))).toBe('token_expired');
    });

    it("a Grant's close cancels every open token of it, both legs given back, and a late commit is refused (F-118-u)", async () => {
      const w = world(WHOLESALE, { reseller: '50' });
      const a = await ask(w.door, w.tx, 'k1');
      const b = await ask(w.door, w.tx, 'k2');
      expect(await w.door.cancelOpen(w.tx, { grantId: GRANT }, NOW)).toBe(2);
      expect(w.tokens.map((t) => t.status)).toEqual(['cancelled', 'cancelled']);
      expect(w.row).toMatchObject({ consumed: n(0), billed: n(0), funded: n(0), wholesaleBilled: n(0) });
      expect(w.wallet.cachedBalance.toFixed(2)).toBe('100.00');
      expect(w.resellerWallet!.cachedBalance.toFixed(2)).toBe('50.00');
      expect(await refusal(w.door.commit(w.tx, { token: a.token, quantity: n(1) }, NOW))).toBe('token_settled');
      expect(b.status).toBe('open');
      // Nothing left open: a second close moves nothing.
      expect(await w.door.cancelOpen(w.tx, { grantId: GRANT }, NOW)).toBe(0);
    });

    it('the sweep expires an open token past its time and gives its money back', async () => {
      const w = world();
      await w.door.authorize(w.tx, { grantId: GRANT, meterKey: KEY, quantity: n(1), key: 'k', ttlMs: -1 }, NOW);
      const out = await w.door.expireDue(NOW);
      expect(out).toEqual({ expired: 1, errors: 0 });
      expect(w.tokens[0].status).toBe('expired');
      expect(w.ledger.map((l) => `${l.direction} ${l.amount}`)).toEqual(['debit 10.00', 'credit 10.00']);
    });
  });
});
