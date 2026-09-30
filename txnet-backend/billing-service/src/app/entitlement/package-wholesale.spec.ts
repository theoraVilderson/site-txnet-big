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
const DAY_S = 86_400;
const MONTH_S = BigInt(30 * DAY_S);

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
  leg?: { billed: bigint; consumed: bigint; inherited?: bigint };
  /** $3.00 per 30 days for `vpn.unlimited.time` when true (F-118-z). */
  timeRate?: boolean;
  /** Days the plan was sold for; null = no end. 30 unless given. */
  days?: number | null;
  /** The existing leg prices time, not bytes. */
  timeLeg?: boolean;
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
    startsAt: SALE,
    endsAt: w.days === null ? null : new Date(SALE.getTime() + (w.days ?? 30) * DAY_S * 1000),
  };
  const legs: Array<Record<string, unknown> & { billed: bigint; consumed: bigint }> = w.leg
    ? [{ id: 'leg-1', tenantId: RESELLER, grantId: GRANT, payerTenantId: RESELLER, rateId: 'rate-1', unitSize: GIB, unitPrice: D('0.20000000'), currencyCode: 'USD', meterKey: 'vpn.traffic', inherited: BigInt(0), ...w.leg }]
    : [];
  if (w.leg && w.timeLeg) Object.assign(legs[0], { meterKey: 'vpn.unlimited.time', rateId: 'rate-t', unitSize: MONTH_S, unitPrice: D('3.00000000') });
  const timeRate = { id: 'rate-t', packageId: PACKAGE, meterKey: 'vpn.unlimited.time', unitSize: MONTH_S, unitPrice: D('3.00000000'), currencyCode: 'USD', effectiveFrom: new Date('2026-06-01T00:00:00Z') };
  const resellerWallet = { id: 'twallet-1', tenantId: RESELLER, currencyCode: 'USD', cachedBalance: D(w.resellerBalance ?? '100.00'), version: 0 };
  const resellerLedger: Array<Record<string, unknown>> = [];

  const tx = {
    tenant: { findUnique: async () => ({ tenantType: w.tenantType ?? TenantType.reseller }) },
    tenantSubscription: { findUnique: async () => ({ package: { id: PACKAGE, currencyCode: 'USD' } }) },
    tenantPackageMeterRate: {
      findMany: async () => [
        ...(w.rate === false
          ? []
          : [{ id: 'rate-1', packageId: PACKAGE, meterKey: 'vpn.traffic', unitSize: GIB, unitPrice: D('0.20000000'), currencyCode: 'USD', effectiveFrom: new Date('2026-06-01T00:00:00Z') }]),
        ...(w.timeRate ? [timeRate] : []),
      ],
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
        const row = { id: 'leg-1', billed: BigInt(0), consumed: BigInt(0), inherited: BigInt(0), meterKey: 'vpn.traffic', ...data };
        legs.push(row);
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: { id: string; billed: bigint; consumed?: bigint }; data: { billed: bigint; consumed?: bigint } }) => {
        if (!legs[0] || where.billed !== legs[0].billed) return { count: 0 };
        if (where.consumed !== undefined && where.consumed !== legs[0].consumed) return { count: 0 };
        Object.assign(legs[0], data);
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

  it('reads nothing for the platform\'s own sale or a metered Grant', async () => {
    for (const w of [
      world({ platformPanel: true, tenantType: TenantType.platform_owner }),
      world({ platformPanel: true, tenantType: TenantType.platform_owner, trafficUnlimited: true, purchasedBytes: BigInt(0), timeRate: true }),
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

describe('an unlimited plan buys its days wholesale, flat per period (F-118-z, D-59 (c))', () => {
  const unlimited = (w: World = {}) => world({ trafficUnlimited: true, purchasedBytes: BigInt(0), timeRate: true, ...w });

  it('buys the days it was sold for at the package\'s `vpn.unlimited.time` rate, naming the Grant', async () => {
    const w = unlimited({ platformPanel: true, days: 90 });

    expect(await leg.open(w.tx, w.grant, SALE)).toBeNull();

    // $3.00 per 30 days, 90 days sold.
    expect(w.resellerLedger).toEqual([
      expect.objectContaining({ amount: D('9.00'), currencyCode: 'USD', reasonType: TenantBillingReasonType.metered_usage_charge, referenceId: GRANT }),
    ]);
    expect(w.legs[0]).toMatchObject({ meterKey: 'vpn.unlimited.time', rateId: 'rate-t', unitSize: MONTH_S, billed: BigInt(90 * DAY_S), consumed: BigInt(0) });
  });

  it('locks the rate but charges nothing on a group of the reseller\'s own panels', async () => {
    const w = unlimited({ platformPanel: false });

    expect(await leg.open(w.tx, w.grant, SALE)).toBeNull();

    expect(w.resellerLedger).toEqual([]);
    expect(w.legs[0]).toMatchObject({ meterKey: 'vpn.unlimited.time', billed: BigInt(0) });
  });

  it('no price, or no end, is no platform panel: refused `wholesale_rate_missing`; on its own panels it sells', async () => {
    for (const w of [unlimited({ platformPanel: true, timeRate: false }), unlimited({ platformPanel: true, days: null })]) {
      expect(await leg.open(w.tx, w.grant, SALE)).toBe('wholesale_rate_missing');
      expect(w.legs).toEqual([]);
      expect(w.resellerLedger).toEqual([]);
    }
    const own = unlimited({ platformPanel: false, timeRate: false });
    expect(await leg.open(own.tx, own.grant, SALE)).toBeNull();
    expect(own.legs).toEqual([]);
  });

  it('refuses a sale the reseller cannot pay for', async () => {
    const w = unlimited({ platformPanel: true, resellerBalance: '2.99' });

    expect(await leg.open(w.tx, w.grant, SALE)).toBe('wholesale_unfunded');

    expect(w.resellerLedger).toEqual([]);
  });

  it('a renewal buys the days it adds, pro rata and rounded up to a cent, naming the renewal', async () => {
    const w = unlimited({ platformPanel: true, leg: { billed: BigInt(30 * DAY_S), consumed: BigInt(0) }, timeLeg: true });

    expect(await leg.renew(w.tx, GRANT, 15, 'renewal-1')).toBeNull();
    expect(await leg.renew(w.tx, GRANT, 7, 'renewal-2')).toBeNull();

    expect(w.resellerLedger).toEqual([
      expect.objectContaining({ amount: D('1.50'), reasonType: TenantBillingReasonType.metered_usage_charge, referenceId: 'renewal-1' }),
      // 7 days of $3.00 per 30 = $0.70.
      expect.objectContaining({ amount: D('0.70'), referenceId: 'renewal-2' }),
    ]);
    expect(w.legs[0].billed).toBe(BigInt(52 * DAY_S));
  });

  it('a renewal on its own panels, of a bag, or with no leg charges nothing; one it cannot pay is refused', async () => {
    const own = unlimited({ platformPanel: false, leg: { billed: BigInt(0), consumed: BigInt(0) }, timeLeg: true });
    expect(await leg.renew(own.tx, GRANT, 30, 'renewal-1')).toBeNull();
    expect(own.resellerLedger).toEqual([]);

    const bag = world({ platformPanel: true, leg: { billed: gib(50), consumed: BigInt(0) } });
    expect(await leg.renew(bag.tx, GRANT, 30, 'renewal-1')).toBeNull();
    expect(bag.resellerLedger).toEqual([]);

    const none = unlimited({ platformPanel: true });
    expect(await leg.renew(none.tx, GRANT, 30, 'renewal-1')).toBeNull();
    expect(none.resellerLedger).toEqual([]);

    const short = unlimited({ platformPanel: true, leg: { billed: BigInt(0), consumed: BigInt(0) }, timeLeg: true, resellerBalance: '1.00' });
    expect(await leg.renew(short.tx, GRANT, 30, 'renewal-1')).toBe('wholesale_unfunded');
    expect(short.legs[0].billed).toBe(BigInt(0));
  });

  it('a bag\'s settle moves nothing on a time leg', async () => {
    const w = unlimited({ platformPanel: true, leg: { billed: BigInt(30 * DAY_S), consumed: BigInt(0) }, timeLeg: true });

    expect(await leg.settle(w.tx, GRANT, 'adjustment-1')).toBeNull();

    expect(w.resellerLedger).toEqual([]);
    expect(w.legs[0].billed).toBe(BigInt(30 * DAY_S));
  });

  it('an admin\'s added days are bought like a renewal\'s, naming the move, to the second', async () => {
    const w = unlimited({ platformPanel: true, leg: { billed: BigInt(30 * DAY_S), consumed: BigInt(0) }, timeLeg: true });

    expect(await leg.extend(w.tx, GRANT, BigInt(10 * DAY_S), 'change-1')).toBeNull();

    // 10 days of $3.00 per 30 = $1.00.
    expect(w.resellerLedger).toEqual([expect.objectContaining({ amount: D('1.00'), reasonType: TenantBillingReasonType.metered_usage_charge, referenceId: 'change-1' })]);
    expect(w.legs[0].billed).toBe(BigInt(40 * DAY_S));
  });
});

describe('an unlimited plan closed early gives back its unused days (F-118-z)', () => {
  const closed = (w: World = {}) =>
    world({ trafficUnlimited: true, purchasedBytes: BigInt(0), timeRate: true, timeLeg: true, status: GrantStatus.cancelled, leg: { billed: BigInt(30 * DAY_S), consumed: BigInt(0) }, ...w });
  const DAY10 = new Date(SALE.getTime() + 10 * DAY_S * 1000);

  it('credits the days left to its end, priced down, once — the leg marked settled', async () => {
    const w = closed();

    expect(await leg.settleAtClose(w.tx, GRANT, DAY10)).toBe(BigInt(0));
    expect(await leg.settleAtClose(w.tx, GRANT, DAY10)).toBe(BigInt(0));

    // 20 of 30 days left at $3.00 per 30.
    expect(w.resellerLedger).toEqual([
      expect.objectContaining({ amount: D('2.00'), reasonType: TenantBillingReasonType.metered_usage_refund, referenceId: GRANT }),
    ]);
    expect(w.legs[0]).toMatchObject({ billed: BigInt(10 * DAY_S), consumed: BigInt(10 * DAY_S) });
  });

  it('gives back no more than was paid for, and nothing past its end or on an open Grant', async () => {
    // 30 days left, only 5 of them bought (sold on its own panels, then a renewal on a platform one).
    const capped = closed({ leg: { billed: BigInt(5 * DAY_S), consumed: BigInt(0) } });
    await leg.settleAtClose(capped.tx, GRANT, SALE);
    expect(capped.resellerLedger).toEqual([expect.objectContaining({ amount: D('0.50'), reasonType: TenantBillingReasonType.metered_usage_refund })]);

    const past = closed();
    await leg.settleAtClose(past.tx, GRANT, new Date(SALE.getTime() + 31 * DAY_S * 1000));
    expect(past.resellerLedger).toEqual([]);
    expect(past.legs[0]).toMatchObject({ billed: BigInt(30 * DAY_S), consumed: BigInt(30 * DAY_S) });

    const open = closed({ status: GrantStatus.active });
    await leg.settleAtClose(open.tx, GRANT, DAY10);
    expect(open.resellerLedger).toEqual([]);
  });
});

describe('a plan sold before F-118-p locks its rate at its next renewal (F-118-ab, D-59 (e))', () => {
  const RENEWAL = new Date(SALE.getTime() + 20 * DAY_S * 1000);

  it('locks the package\'s rate with no charge; the bag left from before is held, never bought', async () => {
    // 50 GiB sold before the leg existed, 20 of them used.
    const w = world({ platformPanel: true, consumedBytes: gib(20) });

    expect(await leg.lockAtRenewal(w.tx, w.grant, RENEWAL)).toBeNull();

    expect(w.resellerLedger).toEqual([]);
    expect(w.legs[0]).toMatchObject({ rateId: 'rate-1', meterKey: 'vpn.traffic', billed: gib(30), inherited: gib(30), consumed: BigInt(0) });
  });

  it('the renewal\'s raise is charged, and only it', async () => {
    const w = world({ platformPanel: true, consumedBytes: gib(20) });
    await leg.lockAtRenewal(w.tx, w.grant, RENEWAL);

    w.grant.purchasedBytes = gib(100);
    expect(await leg.settle(w.tx, GRANT, 'adjustment-1')).toBeNull();

    // 50 GiB added at $0.20; the 30 left from before stay free.
    expect(w.resellerLedger).toEqual([expect.objectContaining({ amount: D('10.00'), reasonType: TenantBillingReasonType.metered_usage_charge, referenceId: 'adjustment-1' })]);
    expect(w.legs[0].billed).toBe(gib(80));
  });

  it('at close gives back only bought bytes: what was held from before never comes back', async () => {
    // 30 GiB held from before, 50 bought at the renewal; 10 served on a platform panel since.
    const w = world({ status: GrantStatus.cancelled, leg: { billed: gib(80), consumed: gib(10), inherited: gib(30) } });

    await leg.settleAtClose(w.tx, GRANT);
    await leg.settleAtClose(w.tx, GRANT);

    // The 50 bought are all unserved: the first 30 served draw on the held bytes.
    expect(w.resellerLedger).toEqual([expect.objectContaining({ amount: D('10.00'), reasonType: TenantBillingReasonType.metered_usage_refund, referenceId: GRANT })]);

    const past = world({ status: GrantStatus.cancelled, leg: { billed: gib(80), consumed: gib(40), inherited: gib(30) } });
    await leg.settleAtClose(past.tx, GRANT);
    // 40 served: 30 held, 10 bought; 40 of the bought come back.
    expect(past.resellerLedger).toEqual([expect.objectContaining({ amount: D('8.00'), reasonType: TenantBillingReasonType.metered_usage_refund })]);
  });

  it('an unlimited plan locks its time rate and the renewal buys only the days it adds', async () => {
    const w = world({ platformPanel: true, trafficUnlimited: true, purchasedBytes: BigInt(0), timeRate: true });

    expect(await leg.lockAtRenewal(w.tx, w.grant, RENEWAL)).toBeNull();
    expect(w.legs[0]).toMatchObject({ meterKey: 'vpn.unlimited.time', billed: BigInt(0), inherited: BigInt(0) });
    expect(await leg.renew(w.tx, GRANT, 30, 'renewal-1')).toBeNull();

    expect(w.resellerLedger).toEqual([expect.objectContaining({ amount: D('3.00'), referenceId: 'renewal-1' })]);
  });

  it('a plan with a leg, the platform\'s own, or a metered Grant is left as it is', async () => {
    for (const w of [
      world({ platformPanel: true, leg: { billed: gib(50), consumed: BigInt(0) } }),
      world({ platformPanel: true, tenantType: TenantType.platform_owner }),
      world({ platformPanel: true, billingMode: VariantBillingMode.metered }),
    ]) {
      const before = w.legs.length;
      expect(await leg.lockAtRenewal(w.tx, w.grant, RENEWAL)).toBeNull();
      expect(w.legs.length).toBe(before);
      expect(w.resellerLedger).toEqual([]);
    }
  });

  it('no rate is refused `wholesale_rate_missing` on a platform panel, as at a sale; on its own panels it renews with no leg', async () => {
    const onPlatform = world({ platformPanel: true, rate: false });
    expect(await leg.lockAtRenewal(onPlatform.tx, onPlatform.grant, RENEWAL)).toBe('wholesale_rate_missing');
    expect(onPlatform.legs).toEqual([]);

    const own = world({ platformPanel: false, rate: false });
    expect(await leg.lockAtRenewal(own.tx, own.grant, RENEWAL)).toBeNull();
    expect(own.legs).toEqual([]);
  });
});
