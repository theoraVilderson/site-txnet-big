import { Prisma, VariantBillingMode, WalletReasonType } from '@prisma/client';
import { METER_KEYS, METERED_RATE_UNIT_BYTES, BLOCK_REQUEST_MESSAGE_VERSION, vpnTrafficRateAt, type RateCardRow } from '@txnet-backend/shared-core';

import { grantMetersFromVariant } from '../entitlement/grant-meter';
import { InsufficientFunds } from '../wallet/wallet-ledger.service';
import { BlockPurchaseRefused, BlockPurchaseService } from './block-purchase';
import { BlockRequestService } from './block-request';
import { VpnReserve } from './vpn-reserve';

/**
 * VPN postpaid (F-118-k, ADR-0105 (6)(7)(12)).
 *
 * The invariant this file holds: **a postpaid VPN Grant is served only on
 * held money, and each byte is charged once, after it is served.** Its bag —
 * what the planner leases (`purchasedBytes`) — is `billed` plus what the open
 * hold buys, so the ceiling stands at what was consumed plus the held bytes.
 * Nothing is debited ahead: the planner's block request captures what was
 * measured from the hold (`usage_charge`) and tops the hold back up; a close
 * captures and releases the rest. Gifted bytes are served first, never
 * charged. A prepaid VPN Grant keeps the block purchaser.
 */
const D = (v: string | number) => new Prisma.Decimal(v);
const GIB = BigInt(METERED_RATE_UNIT_BYTES);
const MIB = GIB / BigInt(1024);

const GRANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const METER_ID = '33333333-3333-4333-8333-333333333333';

function world(opts: { balance?: string; mode?: 'prepaid' | 'postpaid'; consumed?: bigint; purchased?: bigint; billed?: bigint; funded?: bigint; held?: string } = {}) {
  const grant = {
    id: GRANT,
    tenantId: 't1',
    userId: USER,
    status: 'active',
    billingMode: VariantBillingMode.metered,
    trafficUnlimited: false,
    lowBalanceNoticeAt: null,
    consumedBytes: opts.consumed ?? BigInt(0),
    purchasedBytes: opts.purchased ?? opts.funded ?? BigInt(0),
  };
  const meter = {
    id: METER_ID,
    tenantId: 't1',
    grantId: GRANT,
    meterKey: METER_KEYS.vpnTraffic,
    unitSize: GIB,
    // $2.00 a GiB.
    unitPrice: D('2'),
    currencyCode: 'USD',
    mode: opts.mode ?? 'postpaid',
    includedQuantity: BigInt(0),
    afterIncluded: 'metered',
    // The meter's own column stays 0: VPN bytes land on the Grant (F-118-f).
    consumed: BigInt(0),
    billed: opts.billed ?? BigInt(0),
    funded: opts.funded ?? BigInt(0),
  };
  const wallet = { id: 'w1', ownerUserId: USER, currencyCode: 'USD', cachedBalance: D(opts.balance ?? '10'), heldAmount: D(0) };
  const holds = new Map<string, Prisma.Decimal>();
  if (opts.held) {
    holds.set(METER_ID, D(opts.held));
    wallet.heldAmount = D(opts.held);
  }
  const calls: string[] = [];
  const ledger: Array<{ amount: string; reasonType: WalletReasonType }> = [];

  const tx = {
    grant: {
      findUnique: async () => ({ ...grant }),
      update: async ({ data }: { data: { purchasedBytes?: { increment: bigint } } }) => {
        grant.purchasedBytes += data.purchasedBytes?.increment ?? BigInt(0);
        return { ...grant };
      },
      updateMany: async () => ({ count: 1 }),
    },
    grantMeter: {
      findUnique: async ({ where }: { where: { grantId_meterKey: { meterKey: string } } }) =>
        where.grantId_meterKey.meterKey === meter.meterKey ? { ...meter } : null,
      updateMany: async ({ where, data }: { where: { billed: bigint; funded: bigint }; data: { billed?: bigint; funded?: bigint } }) => {
        if (where.billed !== meter.billed || where.funded !== meter.funded) return { count: 0 };
        Object.assign(meter, data);
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
  const holdFake = {
    hold: async (_tx: unknown, e: { ownerRef: string; amount: Prisma.Decimal }) => {
      if (free().lt(e.amount)) throw new InsufficientFunds(USER);
      holds.set(e.ownerRef, (holds.get(e.ownerRef) ?? D(0)).plus(e.amount));
      wallet.heldAmount = wallet.heldAmount.plus(e.amount);
      calls.push(`hold ${e.ownerRef === METER_ID ? 'meter' : 'grant'} ${e.amount.toFixed(2)}`);
    },
    capture: async (_tx: unknown, e: { ownerRef: string; amount: Prisma.Decimal; reasonType: WalletReasonType }) => {
      holds.set(e.ownerRef, holds.get(e.ownerRef)!.minus(e.amount));
      wallet.heldAmount = wallet.heldAmount.minus(e.amount);
      wallet.cachedBalance = wallet.cachedBalance.minus(e.amount);
      ledger.push({ amount: e.amount.toFixed(2), reasonType: e.reasonType });
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
  const ledgerFake = {
    debit: async () => {
      calls.push('debit');
      throw new Error('a postpaid VPN Grant is never debited ahead');
    },
  };
  // A reserve of 1 GiB: $2.00 at this rate.
  const reserve = new VpnReserve(holdFake as never, GIB);
  const blocks = new BlockPurchaseService({} as never, ledgerFake as never, reserve);
  const requests = new BlockRequestService({} as never, {} as never, blocks, reserve);
  const ask = (targetBytes: bigint) =>
    requests.buyIn(tx, {
      version: BLOCK_REQUEST_MESSAGE_VERSION,
      grantId: GRANT,
      purchasedBytes: grant.purchasedBytes.toString(),
      targetBytes: targetBytes.toString(),
      rateBps: 0,
      requestedAt: new Date(0).toISOString(),
    } as never);
  return { tx, grant, meter, wallet, holds, calls, ledger, reserve, blocks, ask };
}

describe('a postpaid vpn.traffic card is sold (F-118-k)', () => {
  const card = (mode: 'prepaid' | 'postpaid'): RateCardRow => ({
    id: 'rc1',
    meterKey: METER_KEYS.vpnTraffic,
    unitSize: GIB,
    // $2.00 a GiB.
    unitPrice: D('2'),
    currencyCode: 'USD',
    mode,
    includedQuantity: BigInt(0),
    afterIncluded: 'metered',
    effectiveFrom: new Date(0),
    isActive: true,
  });

  it('locks its rate and a postpaid grant_meter at issue', () => {
    expect(vpnTrafficRateAt([card('postpaid')], new Date(), 'USD')?.rate.toString()).toBe('2');
    const { meters } = grantMetersFromVariant({ billingMode: VariantBillingMode.metered, rateCards: [card('postpaid')] }, new Date(), 'USD');
    expect(meters.map((m) => m.mode)).toEqual(['postpaid']);
  });
});

describe('the planner asks: held, never debited (ADR-0105 (6))', () => {
  it('holds at least the reserve on the meter and leases what it covers', async () => {
    const w = world();
    const out = await w.ask(BigInt(512) * MIB);
    // 512 MiB is $1.00; the reserve's $2.00 is the floor.
    expect(w.calls).toEqual(['hold meter 2.00']);
    expect(w.ledger).toEqual([]);
    expect(out.served?.held.toFixed(2)).toBe('2.00');
    expect(w.meter.funded).toBe(GIB);
    // The bag is what the hold covers; nothing billed, and no reserve of the Grant's own beside it.
    expect(w.grant.purchasedBytes).toBe(GIB);
    expect(w.meter.billed).toBe(BigInt(0));
    expect(w.holds.has(GRANT)).toBe(false);
  });

  it('captures what was served before it tops the hold back up: the ceiling is consumed plus the held bytes', async () => {
    const w = world({ funded: GIB, held: '2.00', consumed: BigInt(768) * MIB });
    await w.ask(BigInt(512) * MIB);
    // 768 MiB = $1.50 captured, then $0.50 + $1.00 asked = $1.50 is under the $2.00 floor: back to $2.00.
    expect(w.calls).toEqual(['capture 1.50', 'hold meter 1.50']);
    expect(w.ledger).toEqual([{ amount: '1.50', reasonType: WalletReasonType.usage_charge }]);
    expect(w.meter.billed).toBe(BigInt(768) * MIB);
    expect(w.grant.purchasedBytes).toBe(BigInt(768) * MIB + GIB);
  });

  it('holds what was asked on top of what is held, past the floor', async () => {
    const w = world({ funded: GIB, held: '2.00' });
    await w.ask(BigInt(2) * GIB);
    expect(w.calls).toEqual(['hold meter 4.00']);
    expect(w.grant.purchasedBytes).toBe(BigInt(3) * GIB);
  });

  it('serves gifted bytes first and never charges them', async () => {
    // 256 MiB gifted on top of 1 GiB funded; 256 MiB served.
    const w = world({ funded: GIB, purchased: GIB + BigInt(256) * MIB, held: '2.00', consumed: BigInt(256) * MIB });
    await w.ask(BigInt(512) * MIB);
    // Nothing captured; the 512 MiB asked is held on top, and the gift stays in the bag.
    expect(w.ledger).toEqual([]);
    expect(w.calls).toEqual(['hold meter 1.00']);
    expect(w.grant.purchasedBytes).toBe(GIB + BigInt(256 + 512) * MIB);
  });

  it('reports a wallet that cannot hold a cent as short, with nothing written', async () => {
    // Bytes still in the bag, so this is short and not yet exhausted.
    const w = world({ balance: '0.009', funded: GIB });
    const out = await w.ask(BigInt(512) * MIB);
    expect(out.refused).toBe('insufficient_funds');
    expect(out.exhausted).toBeNull();
    expect(w.calls).toEqual([]);
    expect(w.grant.purchasedBytes).toBe(GIB);
  });

  it('is never sold a block: the prepaid purchaser refuses it', async () => {
    const w = world();
    await expect(w.blocks.purchase(w.tx, { grantId: GRANT, targetBytes: GIB })).rejects.toThrow(BlockPurchaseRefused);
    expect(w.calls).toEqual([]);
  });
});

describe('the reserve paths reach the meter hold (F-118-b)', () => {
  it('a top holds the reserve on the meter only when it is short', async () => {
    const short = world();
    await short.reserve.top(short.tx, GRANT);
    expect(short.calls).toEqual(['hold meter 2.00']);
    const full = world({ funded: GIB, held: '2.00', consumed: BigInt(100) * MIB });
    await full.reserve.top(full.tx, GRANT);
    // At its target: no capture a minute, no write.
    expect(full.calls).toEqual([]);
  });

  it('a release captures what was served, gives the rest back and cuts the bag to what was billed', async () => {
    const w = world({ funded: GIB, held: '2.00', consumed: BigInt(768) * MIB });
    const released = await w.reserve.release(w.tx, { id: GRANT, userId: USER });
    expect(w.calls).toEqual(['capture 1.50', 'release 0.50']);
    expect(released.toFixed(2)).toBe('0.50');
    expect(w.meter.funded).toBe(BigInt(768) * MIB);
    expect(w.grant.purchasedBytes).toBe(BigInt(768) * MIB);
    expect(w.meter.billed).toBe(BigInt(768) * MIB);
  });

  it('leaves a prepaid VPN Grant to its block and its own reserve', async () => {
    const w = world({ mode: 'prepaid' });
    await w.reserve.top(w.tx, GRANT);
    expect(w.calls).toEqual(['hold grant 2.00']);
  });
});
