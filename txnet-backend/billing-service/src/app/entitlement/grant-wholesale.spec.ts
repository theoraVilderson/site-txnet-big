/**
 * The wholesale lock (F-118-n2, ADR-0105 decisions 4 and 10): a metered Grant a
 * reseller sells locks, on each `grant_meter`, the rate its package charges
 * for that platform meter — the price the platform will bill the reseller for
 * the usage its user runs on the platform's panels.
 *
 * What breaks without anyone seeing it:
 *  - **a sold Grant repriced wholesale.** The package rate in force at the sale
 *    is copied; one written later is never the one locked (ADR-0073);
 *  - **usage on platform panels that nobody pays for.** A reseller whose
 *    package prices none of the Grant's meters cannot sell it — always, not
 *    only when its panel group holds a platform panel today, since a group's
 *    members change after the sale (user, 2026-09-29). Whether a unit is
 *    charged is decided per usage by its panel's owner (F-118-n3);
 *  - **the platform billing itself.** The platform owner's own sales carry no
 *    wholesale leg, and a package plan (decision 0) never reads a rate.
 *
 * What the database holds (terms locked, all or none) is
 * `entitlement-schema.int.spec.ts`.
 */
import { GrantSource, Prisma, TenantType, VariantBillingMode, VariantVisibility } from '@prisma/client';
import { runWithTenant, type RateCardRow } from '@txnet-backend/shared-core';

import { GrantService } from './grant';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PACKAGE = '22222222-2222-4222-8222-222222222222';
const USER = '44444444-4444-4444-8444-444444444444';
const VARIANT = '66666666-6666-4666-8666-6666666666c1';
const PAYMENT = '99999999-9999-4999-8999-999999999999';
const GIB = BigInt(1073741824);
const SALE = new Date('2026-09-01T10:00:00Z');

const card: RateCardRow = {
  id: 'card',
  meterKey: 'vpn.traffic',
  unitSize: GIB,
  unitPrice: new Prisma.Decimal('0.40000000'),
  currencyCode: 'EUR',
  mode: 'prepaid',
  includedQuantity: BigInt(0),
  afterIncluded: 'metered',
  effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  isActive: true,
};

type PackageRate = {
  id: string;
  packageId: string;
  meterKey: string;
  unitSize: bigint;
  unitPrice: Prisma.Decimal;
  currencyCode: string;
  effectiveFrom: Date;
  isActive: boolean;
  createdAt: Date;
};

const rate = (id: string, over: Partial<PackageRate> = {}): PackageRate => ({
  id,
  packageId: PACKAGE,
  meterKey: 'vpn.traffic',
  unitSize: GIB,
  unitPrice: new Prisma.Decimal('0.15000000'),
  currencyCode: 'USD',
  effectiveFrom: new Date('2026-06-01T00:00:00Z'),
  isActive: true,
  createdAt: new Date('2026-06-01T00:00:00Z'),
  ...over,
});

const variantRow = (billingMode: VariantBillingMode) => ({
  id: VARIANT,
  tenantId: TENANT,
  isActive: true,
  visibility: VariantVisibility.public,
  billingMode,
  quotas: billingMode === VariantBillingMode.prepaid ? { traffic_bytes: { limit: 50 * 1073741824 } } : {},
  durationDays: 30,
  rateCards: [card],
  product: { isActive: true, featureKeys: ['vpn.access'], categories: [{ position: 0, category: { key: 'vpn', isActive: true, parentId: null } }] },
});

function fakeTx(opts: {
  tenantType: TenantType;
  billingMode?: VariantBillingMode;
  subscribed?: boolean;
  rates?: PackageRate[];
}) {
  const grants: Array<Record<string, unknown>> = [];
  const meters: Array<Record<string, unknown>> = [];
  const variant = variantRow(opts.billingMode ?? VariantBillingMode.metered);
  const rates = opts.rates ?? [];
  const tx = {
    tenant: { findUnique: async () => ({ operatingCurrencyCode: 'EUR', tenantType: opts.tenantType }) },
    tenantSubscription: {
      findUnique: vi.fn(async () => (opts.subscribed === false ? null : { package: { id: PACKAGE, currencyCode: 'USD' } })),
    },
    tenantPackageMeterRate: {
      // What the query asks of Postgres: active, in force at the instant, newest first.
      findMany: vi.fn(async ({ where }: { where: { effectiveFrom: { lte: Date } } }) =>
        rates
          .filter((r) => r.isActive && r.effectiveFrom <= where.effectiveFrom.lte)
          .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime()),
      ),
    },
    productVariant: { findUnique: vi.fn(async () => variant) },
    grant: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `grant-${grants.length + 1}`, ...data };
        grants.push(row);
        return row;
      }),
    },
    grantMeter: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        meters.push(...data);
        return { count: data.length };
      }),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient & typeof tx, grants, meters };
}

const service = new GrantService({} as never);
const issue = (tx: Prisma.TransactionClient) =>
  runWithTenant({ id: TENANT }, () =>
    service.issue(tx, { userId: USER, variantId: VARIANT, source: GrantSource.coupon, sourceReferenceId: PAYMENT, startsAt: SALE }),
  );

describe('GrantService.issue locks the wholesale rate on a reseller\'s metered Grant (F-118-n2)', () => {
  it('copies the package rate in force at the sale onto the meter, beside the reseller\'s own card', async () => {
    const later = rate('later', { unitPrice: new Prisma.Decimal('0.09'), effectiveFrom: new Date('2026-10-01T00:00:00Z') });
    const { tx, meters } = fakeTx({ tenantType: TenantType.reseller, rates: [rate('now'), later] });

    await issue(tx);

    expect(meters).toHaveLength(1);
    expect(meters[0]).toMatchObject({
      meterKey: 'vpn.traffic',
      rateCardId: 'card',
      currencyCode: 'EUR',
      wholesalePayerTenantId: TENANT,
      wholesaleRateId: 'now',
      wholesaleUnitSize: GIB,
      wholesaleCurrencyCode: 'USD',
      wholesaleBilled: BigInt(0),
    });
    expect((meters[0]['unitPrice'] as Prisma.Decimal).toString()).toBe('0.4');
    expect((meters[0]['wholesaleUnitPrice'] as Prisma.Decimal).toString()).toBe('0.15');
  });

  it('refuses the sale when the reseller\'s package prices none of the Grant\'s meters, and writes nothing', async () => {
    const { tx, grants, meters } = fakeTx({ tenantType: TenantType.reseller, rates: [rate('ai', { meterKey: 'ai.tokens' })] });

    await expect(issue(tx)).rejects.toMatchObject({ reason: 'wholesale_rate_missing' });
    expect(grants).toHaveLength(0);
    expect(meters).toHaveLength(0);
  });

  it('refuses it when the rate is only scheduled, or switched off', async () => {
    const scheduled = rate('next', { effectiveFrom: new Date('2026-10-01T00:00:00Z') });
    const off = rate('off', { isActive: false });
    const { tx, grants } = fakeTx({ tenantType: TenantType.reseller, rates: [scheduled, off] });

    await expect(issue(tx)).rejects.toMatchObject({ reason: 'wholesale_rate_missing' });
    expect(grants).toHaveLength(0);
  });

  it('refuses it for a reseller with no package at all', async () => {
    const { tx, grants } = fakeTx({ tenantType: TenantType.reseller, subscribed: false, rates: [rate('now')] });

    await expect(issue(tx)).rejects.toMatchObject({ reason: 'wholesale_rate_missing' });
    expect(grants).toHaveLength(0);
  });

  it('gives the platform owner\'s own sale no wholesale leg, and reads no package', async () => {
    const { tx, meters } = fakeTx({ tenantType: TenantType.platform_owner, rates: [rate('now')] });

    await issue(tx);

    expect(meters).toHaveLength(1);
    expect(meters[0]).not.toHaveProperty('wholesaleRateId');
    expect(tx.tenantSubscription.findUnique).not.toHaveBeenCalled();
  });

  it('leaves a reseller\'s package plan off both legs: no meter, no package read (decision 0)', async () => {
    const { tx, grants, meters } = fakeTx({ tenantType: TenantType.reseller, billingMode: VariantBillingMode.prepaid });

    await issue(tx);

    expect(grants).toHaveLength(1);
    expect(meters).toHaveLength(0);
    expect(tx.tenantSubscription.findUnique).not.toHaveBeenCalled();
  });
});
