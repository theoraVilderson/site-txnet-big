import { PanelOwnershipType, Prisma, VariantBillingMode, WalletReasonType } from '@prisma/client';
import { BLOCK_REQUEST_MESSAGE_VERSION, METER_KEYS, METERED_RATE_UNIT_BYTES } from '@txnet-backend/shared-core';

import { InsufficientFunds } from '../wallet/wallet-ledger.service';
import { BlockPurchaseService } from './block-purchase';
import { BlockRequestService } from './block-request';
import { VpnReserve } from './vpn-reserve';

/**
 * Postpaid VPN on the wholesale leg (F-118-n4, ADR-0105 (6)(10), §14.5).
 *
 * The invariant this file holds: **a postpaid Grant's bag never grows past
 * what the reseller has bought wholesale.** The user's side is held and
 * captured after; the reseller's is prepaid whatever the user's mode — so a
 * hold's growth first buys the bytes it funds on the reseller's billing wallet
 * (`metered_usage_charge`), and only then does `funded` move. A reseller short
 * of funds bounds the growth; one at zero holds nothing new, and on a group
 * of its own panels buys nothing ahead.
 */
const D = (v: string | number) => new Prisma.Decimal(v);
const GIB = BigInt(METERED_RATE_UNIT_BYTES);
const MIB = GIB / BigInt(1024);

const GRANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const METER_ID = '33333333-3333-4333-8333-333333333333';
const RESELLER = '44444444-4444-4444-8444-444444444444';
const GROUP = '55555555-5555-4555-8555-555555555555';

type World = {
  resellerBalance?: string;
  platformPanel?: boolean;
  /** Null = the platform's own Grant: no wholesale leg. */
  payer?: string | null;
  funded?: bigint;
  /** The bag, when an admin gifted bytes past `funded`. */
  purchased?: bigint;
  held?: string;
  consumed?: bigint;
  wholesaleBilled?: bigint;
  wholesaleConsumed?: bigint;
};

function world(w: World = {}) {
  const payer = w.payer === undefined ? RESELLER : w.payer;
  const grant = {
    id: GRANT,
    tenantId: RESELLER,
    userId: USER,
    variantId: 'variant-1',
    status: 'active',
    billingMode: VariantBillingMode.metered,
    trafficUnlimited: false,
    lowBalanceNoticeAt: null,
    consumedBytes: w.consumed ?? BigInt(0),
    purchasedBytes: w.purchased ?? w.funded ?? BigInt(0),
  };
  const meter = {
    id: METER_ID,
    grantId: GRANT,
    meterKey: METER_KEYS.vpnTraffic,
    unitSize: GIB,
    // $2.00 a GiB to the user.
    unitPrice: D('2'),
    currencyCode: 'USD',
    mode: 'postpaid',
    includedQuantity: BigInt(0),
    afterIncluded: 'metered',
    consumed: BigInt(0),
    billed: BigInt(0),
    funded: w.funded ?? BigInt(0),
    // $1.00 a GiB wholesale.
    wholesalePayerTenantId: payer,
    wholesaleRateId: payer ? 'rate-1' : null,
    wholesaleUnitSize: payer ? GIB : null,
    wholesaleUnitPrice: payer ? D('1') : null,
    wholesaleCurrencyCode: payer ? 'USD' : null,
    wholesaleBilled: w.wholesaleBilled ?? BigInt(0),
    wholesaleConsumed: w.wholesaleConsumed ?? BigInt(0),
  };
  const wallet = { id: 'w1', ownerUserId: USER, currencyCode: 'USD', cachedBalance: D('100'), heldAmount: D(0) };
  const resellerWallet = { id: 'tw1', tenantId: RESELLER, currencyCode: 'USD', cachedBalance: D(w.resellerBalance ?? '100'), version: 0 };
  const holds = new Map<string, Prisma.Decimal>();
  if (w.held) {
    holds.set(METER_ID, D(w.held));
    wallet.heldAmount = D(w.held);
  }
  const calls: string[] = [];
  const resellerLedger: Array<Record<string, unknown>> = [];

  const tx = {
    tenant: { findFirst: async () => ({ id: 'platform' }), findUnique: async () => ({ operatingCurrencyCode: 'USD' }) },
    grant: {
      // The fair share's reads (F-118-ag): this fake's one Grant, its meter and its holds.
      findMany: async () => [{ id: grant.id }],
      findUnique: async () => ({ ...grant }),
      update: async ({ data }: { data: { purchasedBytes?: { increment: bigint } } }) => {
        grant.purchasedBytes += data.purchasedBytes?.increment ?? BigInt(0);
        return { ...grant };
      },
    },
    productVariant: { findUnique: async () => ({ panelGroupId: GROUP }) },
    panelGroupMember: {
      findFirst: async ({ where }: { where: { panel: { ownershipType: PanelOwnershipType } } }) =>
        where.panel.ownershipType === PanelOwnershipType.platform && w.platformPanel ? { panelId: 'panel-p' } : null,
    },
    grantMeter: {
      findMany: async () => [{ id: METER_ID }],
      findUnique: async () => ({ ...meter }),
      updateMany: async ({ where, data }: { where: Partial<typeof meter>; data: Partial<typeof meter> }) => {
        if (where.wholesaleBilled !== undefined && where.wholesaleBilled !== meter.wholesaleBilled) return { count: 0 };
        if (where.billed !== undefined && (where.billed !== meter.billed || where.funded !== meter.funded)) return { count: 0 };
        if (data.funded !== undefined && data.funded !== meter.funded) calls.push(`funded ${data.funded / MIB} MiB`);
        Object.assign(meter, data);
        return { count: 1 };
      },
    },
    wallet: { findUnique: async () => ({ ...wallet }) },
    walletHold: {
      findMany: async () => [...holds].map(([ownerRef, amount]) => ({ ownerRef, amount })),
      findFirst: async ({ where }: { where: { ownerRef: string } }) => {
        const amount = holds.get(where.ownerRef);
        return amount ? { id: 'h1', ownerRef: where.ownerRef, amount } : null;
      },
    },
    tenantBillingWallet: {
      findUnique: async () => ({ ...resellerWallet }),
      updateMany: async ({ data }: { data: { cachedBalance: Prisma.Decimal } }) => {
        resellerWallet.cachedBalance = data.cachedBalance;
        resellerWallet.version += 1;
        return { count: 1 };
      },
    },
    tenantBillingTransaction: {
      findFirst: async ({ where }: { where: { reasonType: string; referenceId: string } }) =>
        resellerLedger.find((r) => r['reasonType'] === where.reasonType && r['referenceId'] === where.referenceId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `tledger-${resellerLedger.length + 1}`, ...data };
        resellerLedger.push(created);
        calls.push(`wholesale ${(data['amount'] as Prisma.Decimal).toFixed(2)}`);
        return created;
      },
    },
    outboxEvent: { create: async ({ data }: { data: Record<string, unknown> }) => data },
  } as unknown as Prisma.TransactionClient;

  const free = () => wallet.cachedBalance.minus(wallet.heldAmount);
  const holdFake = {
    hold: async (_tx: unknown, e: { ownerRef: string; amount: Prisma.Decimal }) => {
      if (free().lt(e.amount)) throw new InsufficientFunds(USER);
      holds.set(e.ownerRef, (holds.get(e.ownerRef) ?? D(0)).plus(e.amount));
      wallet.heldAmount = wallet.heldAmount.plus(e.amount);
      calls.push(`hold ${e.amount.toFixed(2)}`);
    },
    capture: async (_tx: unknown, e: { ownerRef: string; amount: Prisma.Decimal; reasonType: WalletReasonType }) => {
      holds.set(e.ownerRef, holds.get(e.ownerRef)!.minus(e.amount));
      wallet.heldAmount = wallet.heldAmount.minus(e.amount);
      wallet.cachedBalance = wallet.cachedBalance.minus(e.amount);
      calls.push(`capture ${e.amount.toFixed(2)}`);
      return { id: 'tx-1' };
    },
  };
  // The hold's floor is 1 GiB: $2.00 at this rate.
  const reserve = new VpnReserve(holdFake as never, GIB);
  const requests = new BlockRequestService({} as never, {} as never, new BlockPurchaseService({} as never, {} as never, reserve), reserve);
  const ask = (targetBytes: bigint) =>
    requests.buyIn(tx, {
      version: BLOCK_REQUEST_MESSAGE_VERSION,
      grantId: GRANT,
      purchasedBytes: grant.purchasedBytes.toString(),
      targetBytes: targetBytes.toString(),
      rateBps: 0,
      requestedAt: new Date(0).toISOString(),
    } as never);
  return { tx, grant, meter, resellerWallet, resellerLedger, calls, reserve, ask };
}

describe("a postpaid hold's growth on a reseller Grant (F-118-n4)", () => {
  it('buys the bytes it funds on the reseller wallet before funded moves', async () => {
    const w = world({ platformPanel: true });
    const out = await w.ask(BigInt(2) * GIB);

    // $4.00 held for 2 GiB; the reseller buys those 2 GiB at $1.00 first.
    expect(w.calls).toEqual(['hold 4.00', 'wholesale 2.00', 'funded 2048 MiB']);
    expect(out.served?.funded).toBe(BigInt(2) * GIB);
    expect(w.meter.wholesaleBilled).toBe(BigInt(2) * GIB);
    expect(w.resellerLedger).toMatchObject([{ reasonType: 'metered_usage_charge', currencyCode: 'USD' }]);
    expect(w.resellerWallet.cachedBalance.toFixed(2)).toBe('98.00');
  });

  it('holds only what a short reseller can buy wholesale', async () => {
    const w = world({ platformPanel: true, resellerBalance: '0.50' });
    await w.ask(BigInt(2) * GIB);

    // $0.50 buys 512 MiB wholesale, so the user's hold is $1.00, not $4.00.
    expect(w.calls).toEqual(['hold 1.00', 'wholesale 0.50', 'funded 512 MiB']);
    expect(w.grant.purchasedBytes).toBe(BigInt(512) * MIB);
    expect(w.meter.wholesaleBilled >= w.grant.purchasedBytes).toBe(true);
  });

  it('refuses a reseller at zero with no hold as short, with nothing written', async () => {
    // 256 MiB gifted still in the bag: short, not yet exhausted.
    const w = world({ platformPanel: true, resellerBalance: '0.00', purchased: BigInt(256) * MIB });
    const out = await w.ask(GIB);

    expect(out.refused).toBe('wholesale_unfunded');
    expect(out.exhausted).toBeNull();
    expect(w.calls).toEqual([]);
    expect(w.grant.purchasedBytes).toBe(BigInt(256) * MIB);
  });

  it('does not grow a hold the reseller cannot fund, and does not refuse the Grant it still covers', async () => {
    const w = world({ platformPanel: true, resellerBalance: '0.00', funded: GIB, held: '2.00', wholesaleBilled: GIB });
    const out = await w.ask(GIB);

    expect(out.refused).toBeNull();
    expect(w.calls).toEqual([]);
    expect(w.grant.purchasedBytes).toBe(GIB);
  });

  it("buys nothing ahead on a group of the reseller's own panels, even at zero", async () => {
    const w = world({ platformPanel: false, resellerBalance: '0.00' });
    await w.ask(GIB);

    expect(w.calls).toEqual(['hold 2.00', 'funded 1024 MiB']);
    expect(w.resellerLedger).toEqual([]);
  });

  it('holds nothing new for a reseller at zero on the sweep, and does not throw', async () => {
    const w = world({ platformPanel: true, resellerBalance: '0.00' });
    const held = await w.reserve.top(w.tx, GRANT);

    expect(held.toFixed(2)).toBe('0.00');
    expect(w.calls).toEqual([]);
  });

  it("leaves the platform's own Grant to the user's hold alone", async () => {
    const w = world({ payer: null, resellerBalance: '0.00' });
    await w.ask(GIB);

    expect(w.calls).toEqual(['hold 2.00', 'funded 1024 MiB']);
  });
});
