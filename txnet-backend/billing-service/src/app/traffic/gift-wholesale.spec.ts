/**
 * An admin's byte gift on a reseller's metered Grant, wholesale side
 * (F-118-ac, D-59 (f)). What would break quietly here:
 *
 *  - **the platform's gift billed to the reseller.** Platform staff gift the
 *    bytes: nothing is charged at the gift, the next block does not buy them
 *    as headroom, and at close they are not given back as money the reseller
 *    never paid (`wholesaleGifted`);
 *  - **the reseller's gift given away on the platform's panels.** Its own
 *    staff's gift is bought wholesale at the gift, the charge naming the
 *    `quota_adjustment`, and refused `wholesale_unfunded` when its billing
 *    wallet cannot fund it — before the bag moves, as a raise is;
 *  - **its own panels charged.** On a group with no platform panel a reseller's
 *    gift buys nothing ahead, as a block does not.
 */
import { GrantStatus, PanelOwnershipType, Prisma, TenantBillingReasonType, VariantBillingMode } from '@prisma/client';
import { TenantBillingLedger } from '@txnet-backend/shared-core';

import { WalletLedgerService } from '../wallet/wallet-ledger.service';
import { BlockPurchaseService, GIB } from './block-purchase';
import { giftGrantBytes, GiftGiver } from './gift-bytes';
import { VpnWholesale } from './vpn-wholesale';

const D = (v: string | number) => new Prisma.Decimal(v);
const n = (v: number | bigint) => BigInt(v);
const USER = '44444444-4444-4444-8444-444444444444';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const GRANT = '77777777-7777-4777-8777-777777777777';
const GROUP = '88888888-8888-4888-8888-888888888888';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const AT = new Date('2026-09-30T10:00:00.000Z');

type World = { purchasedBytes?: bigint; wholesaleBilled?: bigint; platformPanel?: boolean; resellerBalance?: string };

/** A reseller's metered Grant, 2 GiB bought and none served; $0.40/GiB to the user, $0.20/GiB wholesale. */
function world(w: World = {}) {
  const grant = {
    id: GRANT,
    userId: USER,
    tenantId: RESELLER,
    variantId: 'variant-1',
    status: GrantStatus.active as GrantStatus,
    statusReason: null,
    suspendedAt: null,
    billingMode: VariantBillingMode.metered,
    trafficUnlimited: false,
    purchasedBytes: w.purchasedBytes ?? n(2) * GIB,
    consumedBytes: n(0),
    endsAt: new Date(AT.getTime() + 10 * 86_400_000),
  };
  const meter = {
    id: 'meter-1',
    grantId: GRANT,
    mode: 'prepaid',
    unitPrice: D('0.40000000'),
    currencyCode: 'USD',
    billed: grant.purchasedBytes,
    funded: grant.purchasedBytes,
    wholesalePayerTenantId: RESELLER,
    wholesaleRateId: 'rate-1',
    wholesaleUnitSize: GIB,
    wholesaleUnitPrice: D('0.20000000'),
    wholesaleCurrencyCode: 'USD',
    wholesaleBilled: w.wholesaleBilled ?? grant.purchasedBytes,
    wholesaleConsumed: n(0),
    wholesaleGifted: n(0),
  };
  const wallet = { id: 'wallet-1', ownerUserId: USER, currencyCode: 'USD', cachedBalance: D('10.00'), heldAmount: D(0), version: 0 };
  const resellerWallet = { id: 'twallet-1', tenantId: RESELLER, currencyCode: 'USD', cachedBalance: D(w.resellerBalance ?? '10.00'), version: 0 };
  const resellerLedger: Array<Record<string, unknown>> = [];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => row[k] === v);

  const tx = {
    tenant: { findUnique: async () => ({ operatingCurrencyCode: 'USD' }), findFirst: async () => ({ operatingCurrencyCode: 'USD' }) },
    grant: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === grant.id ? { ...grant } : null),
      findMany: async () => [],
      update: async ({ data }: { data: { purchasedBytes: { increment: bigint } } }) => {
        grant.purchasedBytes += data.purchasedBytes.increment;
        return { ...grant };
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matches(grant, where)) return { count: 0 };
        Object.assign(grant, data);
        return { count: 1 };
      },
    },
    config: { findMany: async () => [{ counterState: { lifetimeUpBytes: n(0), lifetimeDownBytes: grant.consumedBytes } }] },
    quotaAdjustment: { create: async () => ({ id: 'adjustment-1' }) },
    productVariant: { findUnique: async () => ({ panelGroupId: GROUP }) },
    panelGroupMember: {
      findFirst: async ({ where }: { where: { groupId: string; panel: { ownershipType: PanelOwnershipType } } }) =>
        where.groupId === GROUP && where.panel.ownershipType === PanelOwnershipType.platform && w.platformPanel ? { panelId: 'panel-p' } : null,
    },
    grantMeter: {
      findUnique: async () => ({ ...meter }),
      update: async ({ data }: { data: { billed: { increment: bigint }; funded: { increment: bigint } } }) => {
        meter.billed += data.billed.increment;
        meter.funded += data.funded.increment;
        return { ...meter };
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matches(meter, where)) return { count: 0 };
        Object.assign(meter, data);
        return { count: 1 };
      },
    },
    wallet: {
      findUnique: async () => ({ ...wallet }),
      findUniqueOrThrow: async () => ({ ...wallet }),
      createMany: async () => ({ count: 0 }),
      updateMany: async ({ data }: { data: { cachedBalance: Prisma.Decimal } }) => {
        wallet.cachedBalance = data.cachedBalance;
        wallet.version += 1;
        return { count: 1 };
      },
    },
    walletTransaction: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'ledger-1', ...data }) },
    tenantBillingWallet: {
      findUnique: async () => ({ ...resellerWallet }),
      updateMany: async ({ data }: { data: { cachedBalance: Prisma.Decimal } }) => {
        resellerWallet.cachedBalance = data.cachedBalance;
        resellerWallet.version += 1;
        return { count: 1 };
      },
    },
    tenantBillingTransaction: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `tledger-${resellerLedger.length + 1}`, ...data };
        resellerLedger.push(created);
        return created;
      },
    },
    leaseClose: { findUnique: async () => null },
    walletHold: { findFirst: async () => null },
    outboxEvent: { create: async ({ data }: { data: Record<string, unknown> }) => data },
  };
  /** Bytes served, all on the platform's panel. */
  const serve = (bytes: bigint) => {
    grant.consumedBytes += bytes;
    meter.wholesaleConsumed += bytes;
  };
  return { tx: tx as unknown as Prisma.TransactionClient, grant, meter, resellerWallet, resellerLedger, serve };
}

const gift = (tx: Prisma.TransactionClient, giver: GiftGiver, bytes: bigint) =>
  giftGrantBytes(tx, GRANT, { at: AT, actorUserId: ADMIN, bytes, reason: 'outage 2026-09-29', giver });
const block = (tx: Prisma.TransactionClient) => new BlockPurchaseService({} as never, new WalletLedgerService()).purchase(tx, { grantId: GRANT, targetBytes: GIB });
const close = (tx: Prisma.TransactionClient) => new VpnWholesale(new TenantBillingLedger()).settleAtClose(tx, GRANT);

describe("a platform staff's gift (F-118-ac)", () => {
  it('charges the reseller nothing, now or at the next block', async () => {
    const w = world({ platformPanel: true });

    await gift(w.tx, 'platform', n(5) * GIB);
    expect(w.resellerLedger).toHaveLength(0);
    expect(w.meter.wholesaleBilled).toBe(n(7) * GIB);
    expect(w.meter.wholesaleGifted).toBe(n(5) * GIB);

    // The bag served whole on the platform's panel, then one more GiB: only that GiB is the reseller's.
    w.serve(n(7) * GIB);
    await block(w.tx);
    expect(w.resellerWallet.cachedBalance.toFixed(2)).toBe('9.80');
    expect(w.meter.wholesaleBilled).toBe(n(8) * GIB);
  });

  it('is never given back to the reseller as money at close', async () => {
    const w = world({ platformPanel: true });
    await gift(w.tx, 'platform', n(5) * GIB);
    // 1 GiB of the 2 it paid for served, the gift untouched.
    w.serve(GIB);
    w.grant.status = GrantStatus.cancelled;

    await close(w.tx);
    await close(w.tx);

    // Back: the one GiB it paid for and nobody served, $0.20 — not the gift's $1.00 more.
    expect(w.resellerWallet.cachedBalance.toFixed(2)).toBe('10.20');
    expect(w.resellerLedger).toHaveLength(1);
  });
});

describe("a reseller staff's gift (F-118-ac)", () => {
  it('buys its wholesale at the gift, naming the adjustment, and the next block does not buy it again', async () => {
    const w = world({ platformPanel: true });

    await gift(w.tx, 'reseller', n(5) * GIB);
    expect(w.resellerWallet.cachedBalance.toFixed(2)).toBe('9.00');
    expect(w.resellerLedger[0]).toMatchObject({ reasonType: TenantBillingReasonType.metered_usage_charge, referenceId: 'adjustment-1' });
    expect(w.meter.wholesaleGifted).toBe(n(0));

    w.serve(n(7) * GIB);
    await block(w.tx);
    expect(w.resellerWallet.cachedBalance.toFixed(2)).toBe('8.80');
  });

  it('is refused wholesale_unfunded when the billing wallet cannot fund it, and the bag stays', async () => {
    const w = world({ platformPanel: true, resellerBalance: '0.50' });

    await expect(gift(w.tx, 'reseller', n(5) * GIB)).rejects.toMatchObject({ reason: 'wholesale_unfunded' });
    expect(w.grant.purchasedBytes).toBe(n(2) * GIB);
    expect(w.resellerLedger).toHaveLength(0);
  });

  it("on a group of its own panels, buys nothing ahead — even at zero", async () => {
    const w = world({ platformPanel: false, resellerBalance: '0.00' });

    await gift(w.tx, 'reseller', n(5) * GIB);
    expect(w.grant.purchasedBytes).toBe(n(7) * GIB);
    expect(w.resellerLedger).toHaveLength(0);
  });
});
