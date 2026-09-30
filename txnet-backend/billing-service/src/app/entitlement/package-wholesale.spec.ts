/**
 * A reseller's package plan, bought wholesale (F-118-p, ADR-0105 (0) amended
 * 2026-09-29): a plan paid in full that a reseller sells on the platform's
 * panels is charged its bag at the package's wholesale rate on the reseller's
 * `tenant_billing_wallet` — at the sale and at every raise of the bag — and
 * what no platform panel served comes back at close. The user's path is
 * untouched: no meter, no hold, no read of the user's wallet.
 *
 * What breaks without anyone seeing it:
 *  - **a plan the platform serves for free.** A bag sold on a group holding a
 *    platform panel is bought in the same transaction, or the sale is refused;
 *    a renewal or an admin's raise buys what it adds;
 *  - **a reseller charged for its own panels.** A group of its own panels buys
 *    nothing ahead, and at close every byte no platform panel served comes back;
 *  - **a negative wallet.** A reseller short of the price is refused, nothing
 *    written (§5.4);
 *  - **the platform billing itself**, or an unlimited plan or a metered Grant
 *    (F-118-n3's leg) charged twice.
 */
import { GrantStatus, PanelOwnershipType, Prisma, TenantBillingReasonType, TenantType, VariantBillingMode } from '@prisma/client';

import { PackageWholesale } from './package-wholesale';

const D = (v: string | number) => new Prisma.Decimal(v);
const GIB = BigInt(1073741824);
const gib = (v: number) => BigInt(v) * GIB;
const RESELLER = '22222222-2222-4222-8222-222222222222';
const PACKAGE = '33333333-3333-4333-8333-333333333333';
const GRANT = '77777777-7777-4777-8777-777777777777';
const GROUP = '88888888-8888-4888-8888-888888888888';
const SALE = new Date('2026-09-29T10:00:00Z');

type World = {
  tenantType?: TenantType;
  billingMode?: VariantBillingMode;
  trafficUnlimited?: boolean;
  purchasedBytes?: bigint;
  consumedBytes?: bigint;
  platformPanel?: boolean;
  /** $0.20 per GiB unless false: the package prices no `vpn.traffic`. */
  rate?: boolean;
  resellerBalance?: string;
  status?: GrantStatus;
  /** An existing leg's cursors; none = no row yet. */
  leg?: { billed: bigint; consumed: bigint };
};

function world(w: World = {}) {
  const grant = {
    id: GRANT,
    tenantId: RESELLER,
    variantId: 'variant-1',
    status: w.status ?? GrantStatus.active,
    billingMode: w.billingMode ?? VariantBillingMode.prepaid,
    trafficUnlimited: w.trafficUnlimited ?? false,
    purchasedBytes: w.purchasedBytes ?? gib(50),
    consumedBytes: w.consumedBytes ?? BigInt(0),
  };
  const legs: Array<Record<string, unknown> & { billed: bigint; consumed: bigint }> = w.leg
    ? [{ id: 'leg-1', tenantId: RESELLER, grantId: GRANT, payerTenantId: RESELLER, rateId: 'rate-1', unitSize: GIB, unitPrice: D('0.20000000'), currencyCode: 'USD', ...w.leg }]
    : [];
  const resellerWallet = { id: 'twallet-1', tenantId: RESELLER, currencyCode: 'USD', cachedBalance: D(w.resellerBalance ?? '100.00'), version: 0 };
  const resellerLedger: Array<Record<string, unknown>> = [];

  const tx = {
    tenant: { findUnique: async () => ({ tenantType: w.tenantType ?? TenantType.reseller }) },
    tenantSubscription: { findUnique: async () => ({ package: { id: PACKAGE, currencyCode: 'USD' } }) },
    tenantPackageMeterRate: {
      findMany: async () =>
        w.rate === false
          ? []
          : [{ id: 'rate-1', packageId: PACKAGE, meterKey: 'vpn.traffic', unitSize: GIB, unitPrice: D('0.20000000'), currencyCode: 'USD', effectiveFrom: new Date('2026-06-01T00:00:00Z') }],
    },
    productVariant: { findUnique: async () => ({ panelGroupId: GROUP }) },
    panelGroupMember: {
      findFirst: async ({ where }: { where: { groupId: string; panel: { ownershipType: PanelOwnershipType } } }) =>
        where.groupId === GROUP && where.panel.ownershipType === PanelOwnershipType.platform && w.platformPanel ? { panelId: 'panel-p' } : null,
    },
    grant: { findUnique: async () => ({ ...grant }) },
    grantWholesale: {
      findUnique: async () => (legs[0] ? { ...legs[0] } : null),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'leg-1', billed: BigInt(0), consumed: BigInt(0), ...data };
        legs.push(row);
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: { id: string; billed: bigint }; data: { billed: bigint } }) => {
        if (!legs[0] || where.billed !== legs[0].billed) return { count: 0 };
        legs[0].billed = data.billed;
        return { count: 1 };
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
  return { tx: tx as unknown as Prisma.TransactionClient, grant, legs, resellerWallet, resellerLedger };
}

const leg = new PackageWholesale();

describe('a reseller\'s package plan is bought wholesale at the sale (F-118-p)', () => {
  it('buys the whole bag on the reseller\'s billing wallet when the group holds a platform panel', async () => {
    const w = world({ platformPanel: true });

    expect(await leg.open(w.tx, w.grant, SALE)).toBeNull();

    // 50 GiB at $0.20 per GiB.
    expect(w.resellerLedger).toEqual([
      expect.objectContaining({ walletId: 'twallet-1', amount: D('10.00'), currencyCode: 'USD', reasonType: TenantBillingReasonType.metered_usage_charge, referenceId: GRANT }),
    ]);
    expect(w.resellerWallet.cachedBalance.toFixed(2)).toBe('90.00');
    expect(w.legs[0]).toMatchObject({ grantId: GRANT, payerTenantId: RESELLER, rateId: 'rate-1', unitSize: GIB, currencyCode: 'USD', billed: gib(50) });
  });

  it('locks the rate but buys nothing ahead on a group of the reseller\'s own panels', async () => {
    const w = world({ platformPanel: false });

    expect(await leg.open(w.tx, w.grant, SALE)).toBeNull();

    expect(w.resellerLedger).toEqual([]);
    expect(w.legs[0]).toMatchObject({ rateId: 'rate-1', billed: BigInt(0) });
  });

  it('refuses the sale when the reseller cannot pay, and writes nothing', async () => {
    const w = world({ platformPanel: true, resellerBalance: '9.99' });

    expect(await leg.open(w.tx, w.grant, SALE)).toBe('wholesale_unfunded');

    expect(w.resellerLedger).toEqual([]);
    expect(w.resellerWallet.cachedBalance.toFixed(2)).toBe('9.99');
  });

  it('refuses a sale on a platform panel when the package prices no VPN traffic; on its own panels it sells, with no leg', async () => {
    const onPlatform = world({ platformPanel: true, rate: false });
    expect(await leg.open(onPlatform.tx, onPlatform.grant, SALE)).toBe('wholesale_rate_missing');
    expect(onPlatform.legs).toEqual([]);

    const own = world({ platformPanel: false, rate: false });
    expect(await leg.open(own.tx, own.grant, SALE)).toBeNull();
    expect(own.legs).toEqual([]);
  });

  it('reads nothing for the platform\'s own sale, an unlimited plan or a metered Grant', async () => {
    for (const w of [
      world({ platformPanel: true, tenantType: TenantType.platform_owner }),
      world({ platformPanel: true, trafficUnlimited: true, purchasedBytes: BigInt(0) }),
      world({ platformPanel: true, billingMode: VariantBillingMode.metered }),
    ]) {
      expect(await leg.open(w.tx, w.grant, SALE)).toBeNull();
      expect(w.legs).toEqual([]);
      expect(w.resellerLedger).toEqual([]);
    }
  });
});

describe('a raise of the bag buys what it adds (F-118-p)', () => {
  it('a renewal buys the headroom past what was bought and not yet served on a platform panel', async () => {
    // 50 GiB bought; 30 served on the reseller's panels, 10 on the platform's; renewed to 100.
    const w = world({ platformPanel: true, purchasedBytes: gib(100), consumedBytes: gib(40), leg: { billed: gib(50), consumed: gib(10) } });

    expect(await leg.settle(w.tx, GRANT, 'adjustment-1')).toBeNull();

    // Owed to: 10 served + 60 left in the bag = 70; 20 more at $0.20.
    expect(w.resellerLedger).toEqual([expect.objectContaining({ amount: D('4.00'), reasonType: TenantBillingReasonType.metered_usage_charge, referenceId: 'adjustment-1' })]);
    expect(w.legs[0].billed).toBe(gib(70));
  });

  it('on its own panels only, buys just the platform bytes already served and not yet paid for', async () => {
    // A platform panel served 5 GiB, then left the group.
    const w = world({ platformPanel: false, purchasedBytes: gib(100), consumedBytes: gib(40), leg: { billed: BigInt(0), consumed: gib(5) } });

    expect(await leg.settle(w.tx, GRANT, 'adjustment-1')).toBeNull();

    expect(w.resellerLedger).toEqual([expect.objectContaining({ amount: D('1.00'), referenceId: 'adjustment-1' })]);
    expect(w.legs[0].billed).toBe(gib(5));
  });

  it('refuses a raise the reseller cannot pay for, and a Grant with no leg moves nothing', async () => {
    const short = world({ platformPanel: true, purchasedBytes: gib(100), leg: { billed: gib(50), consumed: BigInt(0) }, resellerBalance: '5.00' });
    expect(await leg.settle(short.tx, GRANT, 'adjustment-1')).toBe('wholesale_unfunded');
    expect(short.resellerLedger).toEqual([]);

    const none = world({ platformPanel: true });
    expect(await leg.settle(none.tx, GRANT, 'adjustment-1')).toBeNull();
    expect(none.resellerLedger).toEqual([]);
  });
});

describe('what no platform panel served comes back at close (F-118-p)', () => {
  it('credits the unserved part, priced down, once', async () => {
    const w = world({ status: GrantStatus.cancelled, leg: { billed: gib(50), consumed: gib(10) } });

    await leg.settleAtClose(w.tx, GRANT);
    await leg.settleAtClose(w.tx, GRANT);

    // 40 GiB at $0.20.
    expect(w.resellerLedger).toEqual([
      expect.objectContaining({ amount: D('8.00'), reasonType: TenantBillingReasonType.metered_usage_refund, referenceId: GRANT }),
    ]);
    expect(w.legs[0].billed).toBe(gib(10));
  });

  it('gives nothing back on an open Grant', async () => {
    const w = world({ status: GrantStatus.suspended, leg: { billed: gib(50), consumed: gib(10) } });

    await leg.settleAtClose(w.tx, GRANT);

    expect(w.resellerLedger).toEqual([]);
  });
});

describe('a close charges what a platform panel served past the cursor (F-118-y)', () => {
  // A platform panel joined the group after the last raise: its bytes were never bought.
  it('charges the bytes served past `billed`, the cursor to `consumed`, once', async () => {
    const w = world({ status: GrantStatus.expired, leg: { billed: gib(10), consumed: gib(30) } });

    expect(await leg.settleAtClose(w.tx, GRANT)).toBe(BigInt(0));
    expect(await leg.settleAtClose(w.tx, GRANT)).toBe(BigInt(0));

    // 20 GiB at $0.20.
    expect(w.resellerLedger).toEqual([
      expect.objectContaining({ amount: D('4.00'), reasonType: TenantBillingReasonType.metered_usage_charge, referenceId: GRANT }),
    ]);
    expect(w.legs[0].billed).toBe(gib(30));
  });

  it('charges only what the balance covers and answers the rest, never below zero', async () => {
    const w = world({ status: GrantStatus.expired, leg: { billed: gib(10), consumed: gib(30) }, resellerBalance: '1.00' });

    // $1.00 buys 5 GiB; 15 GiB stay unpaid, the gap left on the cursor.
    expect(await leg.settleAtClose(w.tx, GRANT)).toBe(gib(15));

    expect(w.resellerLedger).toEqual([expect.objectContaining({ amount: D('1.00'), reasonType: TenantBillingReasonType.metered_usage_charge })]);
    expect(w.resellerWallet.cachedBalance.toFixed(2)).toBe('0.00');
    expect(w.legs[0].billed).toBe(gib(15));
  });

  it('charges nothing on an open Grant', async () => {
    const w = world({ status: GrantStatus.suspended, leg: { billed: gib(10), consumed: gib(30) } });

    expect(await leg.settleAtClose(w.tx, GRANT)).toBe(BigInt(0));

    expect(w.resellerLedger).toEqual([]);
  });
});
