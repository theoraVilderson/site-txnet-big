/**
 * The wholesale leg of a VPN block (F-118-n3, ADR-0105 (10), §14.5).
 *
 * What breaks without anyone seeing it:
 *  - **a platform-panel byte served that the reseller never paid for.** A block
 *    on a Grant whose group holds a platform panel is bought on both wallets in
 *    one transaction, and the block is no larger than the reseller's side funds;
 *  - **a reseller charged for its own panels.** A group of its own panels only
 *    buys nothing wholesale ahead; bytes already served on a platform panel are
 *    still owed and bought first;
 *  - **the prepayment kept.** What the reseller bought and no platform panel
 *    served comes back at close, priced down.
 */
import { GrantStatus, LedgerDirection, PanelOwnershipType, Prisma, TenantBillingReasonType, VariantBillingMode, WalletReasonType } from '@prisma/client';
import { WalletLedgerService } from '../wallet/wallet-ledger.service';
import { BlockPurchaseService, GIB } from './block-purchase';
import { VpnWholesale } from './vpn-wholesale';
import { TenantBillingLedger } from '@txnet-backend/shared-core';

const D = (v: string | number) => new Prisma.Decimal(v);
const n = (v: number | bigint) => BigInt(v);
const USER = '44444444-4444-4444-8444-444444444444';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const GRANT = '77777777-7777-4777-8777-777777777777';
const GROUP = '88888888-8888-4888-8888-888888888888';

type World = {
  /** Bytes, as the Grant and its meter hold them. */
  purchasedBytes?: bigint;
  consumedBytes?: bigint;
  wholesaleBilled?: bigint;
  wholesaleConsumed?: bigint;
  /** Null = the platform's own Grant: no wholesale leg. */
  payer?: string | null;
  platformPanel?: boolean;
  userBalance?: string;
  resellerBalance?: string;
  status?: GrantStatus;
};

function world(w: World = {}) {
  const grant = {
    id: GRANT,
    userId: USER,
    tenantId: RESELLER,
    variantId: 'variant-1',
    status: w.status ?? GrantStatus.active,
    billingMode: VariantBillingMode.metered,
    purchasedBytes: w.purchasedBytes ?? n(0),
    consumedBytes: w.consumedBytes ?? n(0),
  };
  const payer = w.payer === undefined ? RESELLER : w.payer;
  const meter = {
    id: 'meter-1',
    grantId: GRANT,
    mode: 'prepaid',
    // $0.40 per GiB to the user, $0.20 per GiB wholesale.
    unitPrice: D('0.40000000'),
    currencyCode: 'USD',
    billed: grant.purchasedBytes,
    funded: grant.purchasedBytes,
    wholesalePayerTenantId: payer,
    wholesaleRateId: payer ? 'rate-1' : null,
    wholesaleUnitSize: payer ? GIB : null,
    wholesaleUnitPrice: payer ? D('0.20000000') : null,
    wholesaleCurrencyCode: payer ? 'USD' : null,
    wholesaleBilled: w.wholesaleBilled ?? n(0),
    wholesaleConsumed: w.wholesaleConsumed ?? n(0),
  };
  const wallet = { id: 'wallet-1', ownerUserId: USER, currencyCode: 'USD', cachedBalance: D(w.userBalance ?? '10.00'), heldAmount: D(0), version: 0 };
  const resellerWallet = { id: 'twallet-1', tenantId: RESELLER, currencyCode: 'USD', cachedBalance: D(w.resellerBalance ?? '10.00'), version: 0 };
  const ledger: Array<Record<string, unknown>> = [];
  const resellerLedger: Array<Record<string, unknown>> = [];

  const tx = {
    tenant: { findUnique: async () => ({ operatingCurrencyCode: 'USD' }), findFirst: async () => ({ operatingCurrencyCode: 'USD' }) },
    grant: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === grant.id ? { ...grant } : null),
      update: async ({ data }: { data: { purchasedBytes: { increment: bigint } } }) => {
        grant.purchasedBytes += data.purchasedBytes.increment;
        return { ...grant };
      },
    },
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
      updateMany: async ({ where, data }: { where: { id: string; wholesaleBilled: bigint }; data: { wholesaleBilled: bigint } }) => {
        if (where.wholesaleBilled !== meter.wholesaleBilled) return { count: 0 };
        meter.wholesaleBilled = data.wholesaleBilled;
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
    walletTransaction: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `ledger-${ledger.length + 1}`, ...data };
        ledger.push(created);
        return created;
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
        return created;
      },
    },
    outboxEvent: { create: async ({ data }: { data: Record<string, unknown> }) => data },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, grant, meter, wallet, resellerWallet, ledger, resellerLedger };
}

const service = () => new BlockPurchaseService({} as never, new WalletLedgerService());
const buy = (tx: Prisma.TransactionClient, targetBytes = GIB) => service().purchase(tx, { grantId: GRANT, targetBytes });

describe('a VPN block on a reseller Grant (F-118-n3)', () => {
  it('on a group with a platform panel, buys the block on both wallets in one go', async () => {
    const w = world({ platformPanel: true });

    const block = await buy(w.tx);

    expect(block.amount.toFixed(2)).toBe('0.40');
    expect(w.wallet.cachedBalance.toFixed(2)).toBe('9.60');
    expect(w.resellerWallet.cachedBalance.toFixed(2)).toBe('9.80');
    expect(w.meter.wholesaleBilled).toBe(GIB);
    expect(w.resellerLedger).toHaveLength(1);
    // The reseller's charge names the block it paid for: one row per block.
    expect(w.resellerLedger[0]).toMatchObject({
      direction: 'debit',
      reasonType: TenantBillingReasonType.metered_usage_charge,
      referenceId: block.walletTransactionId,
    });
  });

  it("is no larger than the reseller's side funds", async () => {
    // 5c wholesale buys a quarter GiB; the user could fund the whole GiB.
    const w = world({ platformPanel: true, resellerBalance: '0.05' });

    const block = await buy(w.tx);

    expect(block.bytes <= GIB / n(4)).toBe(true);
    expect(w.meter.wholesaleBilled >= w.grant.purchasedBytes).toBe(true);
    expect(w.resellerWallet.cachedBalance.gte(0)).toBe(true);
  });

  it('refuses a reseller at zero, and writes nothing on either wallet', async () => {
    const w = world({ platformPanel: true, resellerBalance: '0.00' });

    await expect(buy(w.tx)).rejects.toMatchObject({ reason: 'wholesale_unfunded' });
    expect(w.grant.purchasedBytes).toBe(n(0));
    expect(w.ledger).toHaveLength(0);
    expect(w.resellerLedger).toHaveLength(0);
  });

  it("on a group of the reseller's own panels, buys nothing wholesale — even at zero", async () => {
    const w = world({ platformPanel: false, resellerBalance: '0.00' });

    const block = await buy(w.tx);

    expect(block.amount.toFixed(2)).toBe('0.40');
    expect(w.resellerLedger).toHaveLength(0);
    expect(w.meter.wholesaleBilled).toBe(n(0));
  });

  it('bytes already served on a platform panel are owed first, whatever the group holds now', async () => {
    const owed = world({ platformPanel: false, purchasedBytes: GIB, consumedBytes: GIB, wholesaleConsumed: GIB });
    await buy(owed.tx);
    expect(owed.meter.wholesaleBilled).toBe(GIB);
    expect(owed.resellerWallet.cachedBalance.toFixed(2)).toBe('9.80');

    const broke = world({ platformPanel: false, purchasedBytes: GIB, consumedBytes: GIB, wholesaleConsumed: GIB, resellerBalance: '0.00' });
    await expect(buy(broke.tx)).rejects.toMatchObject({ reason: 'wholesale_unfunded' });
    expect(broke.ledger).toHaveLength(0);
  });

  it('bought ahead and served on its own panels, carries forward instead of charging again', async () => {
    // 10 GiB bought wholesale ahead, 7 served on its own panels, 3 on the platform's.
    const w = world({ platformPanel: true, purchasedBytes: n(10) * GIB, consumedBytes: n(10) * GIB, wholesaleConsumed: n(3) * GIB, wholesaleBilled: n(10) * GIB });

    await buy(w.tx);

    expect(w.resellerLedger).toHaveLength(0);
    expect(w.meter.wholesaleBilled).toBe(n(10) * GIB);
  });

  it("the platform's own Grant has no wholesale leg and reads no reseller wallet", async () => {
    const w = world({ payer: null, platformPanel: true, resellerBalance: '0.00' });

    await buy(w.tx);

    expect(w.resellerLedger).toHaveLength(0);
    expect(w.ledger[0]).toMatchObject({ direction: LedgerDirection.debit, reasonType: WalletReasonType.traffic_consumption });
  });
});

describe('the wholesale remainder at close (F-118-n3)', () => {
  const wholesale = () => new VpnWholesale(new TenantBillingLedger());

  it('gives back what the reseller bought and no platform panel served, priced down', async () => {
    const w = world({ status: GrantStatus.cancelled, wholesaleBilled: n(10) * GIB, wholesaleConsumed: n(3) * GIB });

    await wholesale().settleAtClose(w.tx, GRANT);

    expect(w.resellerLedger).toHaveLength(1);
    expect(w.resellerLedger[0]).toMatchObject({ direction: 'credit', reasonType: TenantBillingReasonType.metered_usage_refund, referenceId: GRANT });
    expect(w.resellerWallet.cachedBalance.toFixed(2)).toBe('11.40');
    expect(w.meter.wholesaleBilled).toBe(n(3) * GIB);

    // The cursor is the guard: a second close finds nothing.
    await wholesale().settleAtClose(w.tx, GRANT);
    expect(w.resellerLedger).toHaveLength(1);
  });

  it('moves nothing on a Grant with no leg, or one still open', async () => {
    const none = world({ payer: null, status: GrantStatus.cancelled, wholesaleBilled: GIB });
    await wholesale().settleAtClose(none.tx, GRANT);
    expect(none.resellerLedger).toHaveLength(0);

    const open = world({ wholesaleBilled: GIB });
    await wholesale().settleAtClose(open.tx, GRANT);
    expect(open.resellerLedger).toHaveLength(0);
  });

  // F-118-y: a platform panel joined the group after the last block, and served bytes nobody bought.
  it('charges the bytes served past `wholesaleBilled`, the cursor to `wholesaleConsumed`, once', async () => {
    const w = world({ status: GrantStatus.expired, wholesaleBilled: n(3) * GIB, wholesaleConsumed: n(8) * GIB });

    expect(await wholesale().settleAtClose(w.tx, GRANT)).toBe(n(0));
    expect(await wholesale().settleAtClose(w.tx, GRANT)).toBe(n(0));

    // 5 GiB at $0.20.
    expect(w.resellerLedger).toHaveLength(1);
    expect(w.resellerLedger[0]).toMatchObject({ direction: 'debit', reasonType: TenantBillingReasonType.metered_usage_charge, referenceId: GRANT });
    expect(w.resellerWallet.cachedBalance.toFixed(2)).toBe('9.00');
    expect(w.meter.wholesaleBilled).toBe(n(8) * GIB);
  });

  it('charges only what the reseller\'s balance covers and answers the rest, never below zero', async () => {
    const w = world({ status: GrantStatus.expired, wholesaleBilled: n(3) * GIB, wholesaleConsumed: n(8) * GIB, resellerBalance: '0.50' });

    // $0.50 buys 2.5 GiB of the 5.
    expect(await wholesale().settleAtClose(w.tx, GRANT)).toBe((n(5) * GIB) / n(2));

    expect(w.resellerWallet.cachedBalance.toFixed(2)).toBe('0.00');
    expect(w.meter.wholesaleBilled).toBe(n(3) * GIB + (n(5) * GIB) / n(2));
  });
});
