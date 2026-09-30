/**
 * The metered cap (F-118-ao): a metered Grant costs nothing at the sale, so a
 * user holds at most N open ones — the platform's 5, the tenant's own default,
 * or the user's own number set by staff (`contract.limits.md`).
 *
 * What breaks without anyone seeing it:
 *  - **panels filled for free.** A user past the cap is refused at the sale,
 *    and two sales at once cannot both pass it: the count is taken under a
 *    per-user lock;
 *  - **a ticket answered and ignored.** The user's own number wins over the
 *    tenant's, higher or lower, and the tenant's over the platform's;
 *  - **a closed service held against the user.** Only `pending`, `active` and
 *    `suspended` count, and only metered ones;
 *  - **staff refused.** What an admin issues counts, and is never refused.
 */
import { GrantSource, GrantStatus, Prisma, VariantBillingMode, VariantVisibility } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { GrantService } from './grant';
import { assertMeteredRoom, MeteredCapReached, meteredCapOf, PLATFORM_METERED_CAP } from './metered-cap';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const VARIANT = '66666666-6666-4666-8666-6666666666c1';
const INVOICE = '99999999-9999-4999-8999-999999999999';
const GIB = BigInt(1073741824);

function fakeTx(opts: { open: number; tenantCap?: number; userCap?: number; billingMode?: VariantBillingMode }) {
  const calls: string[] = [];
  const grants: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: vi.fn(async () => {
      calls.push('lock');
      return 1;
    }),
    grantLimitSetting: { findUnique: vi.fn(async () => (opts.tenantCap === undefined ? null : { meteredOpenCap: opts.tenantCap })) },
    userGrantLimit: { findUnique: vi.fn(async () => (opts.userCap === undefined ? null : { meteredOpenCap: opts.userCap })) },
    tenant: { findUnique: async () => ({ operatingCurrencyCode: 'EUR', tenantType: 'platform' }) },
    tenantSubscription: { findUnique: async () => null },
    tenantPackageMeterRate: { findMany: async () => [] },
    productVariant: {
      findUnique: async () => ({
        id: VARIANT,
        tenantId: TENANT,
        isActive: true,
        visibility: VariantVisibility.public,
        billingMode: opts.billingMode ?? VariantBillingMode.metered,
        quotas: opts.billingMode === VariantBillingMode.prepaid ? { traffic_bytes: { limit: 50 * 1073741824 } } : {},
        durationDays: 30,
        rateCards: [
          {
            id: 'card',
            meterKey: 'vpn.traffic',
            unitSize: GIB,
            unitPrice: new Prisma.Decimal('0.4'),
            currencyCode: 'EUR',
            mode: 'postpaid',
            includedQuantity: BigInt(0),
            afterIncluded: 'metered',
            effectiveFrom: new Date('2026-01-01T00:00:00Z'),
            isActive: true,
          },
        ],
        product: { isActive: true, featureKeys: ['vpn.access'], categories: [{ position: 0, category: { key: 'vpn', isActive: true, parentId: null } }] },
      }),
    },
    grant: {
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => {
        calls.push('count');
        return opts.open;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `grant-${grants.length + 1}`, ...data };
        grants.push(row);
        return row;
      }),
    },
    grantMeter: { createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient & typeof tx, calls, grants };
}

const inTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);
const service = new GrantService({} as never);
const issue = (tx: Prisma.TransactionClient, source: GrantSource = GrantSource.purchase) =>
  inTenant(() => service.issue(tx, { userId: USER, variantId: VARIANT, source, sourceReferenceId: INVOICE }));

describe('meteredCapOf (F-118-ao)', () => {
  it('is the platform default with nothing set', async () => {
    const { tx } = fakeTx({ open: 0 });
    expect(PLATFORM_METERED_CAP).toBe(5);
    await expect(inTenant(() => meteredCapOf(tx, USER))).resolves.toBe(5);
  });

  it("is the tenant's own default over the platform's", async () => {
    const { tx } = fakeTx({ open: 0, tenantCap: 2 });
    await expect(inTenant(() => meteredCapOf(tx, USER))).resolves.toBe(2);
  });

  it("is the user's own number over the tenant's, higher or lower", async () => {
    await expect(inTenant(() => meteredCapOf(fakeTx({ open: 0, tenantCap: 2, userCap: 20 }).tx, USER))).resolves.toBe(20);
    await expect(inTenant(() => meteredCapOf(fakeTx({ open: 0, tenantCap: 8, userCap: 0 }).tx, USER))).resolves.toBe(0);
  });
});

describe('assertMeteredRoom (F-118-ao)', () => {
  it('counts only open metered Grants of the user, under the lock', async () => {
    const { tx, calls } = fakeTx({ open: 4 });

    await inTenant(() => assertMeteredRoom(tx, USER));

    expect(calls).toEqual(['lock', 'count']);
    expect(tx.grant.count).toHaveBeenCalledWith({
      where: {
        userId: USER,
        billingMode: VariantBillingMode.metered,
        status: { in: [GrantStatus.pending, GrantStatus.active, GrantStatus.suspended] },
      },
    });
  });

  it('refuses at the cap and names it', async () => {
    const { tx } = fakeTx({ open: 5 });

    const refused = await inTenant(() => assertMeteredRoom(tx, USER)).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(MeteredCapReached);
    expect(refused).toMatchObject({ reason: 'metered_cap_reached', cap: 5, open: 5 });
  });
});

describe('GrantService.issue holds the metered cap (F-118-ao)', () => {
  it('refuses a purchase past the cap and writes nothing', async () => {
    const { tx, grants } = fakeTx({ open: 3, userCap: 3 });

    await expect(issue(tx)).rejects.toMatchObject({ reason: 'metered_cap_reached', cap: 3 });
    expect(grants).toHaveLength(0);
  });

  it('sells one under it', async () => {
    const { tx, grants } = fakeTx({ open: 4 });

    await issue(tx);

    expect(grants).toHaveLength(1);
  });

  it("never refuses staff's own issue, and counts nothing for it", async () => {
    const { tx, grants } = fakeTx({ open: 9 });

    await issue(tx, GrantSource.admin_grant);

    expect(grants).toHaveLength(1);
    expect(tx.grant.count).not.toHaveBeenCalled();
  });

  it('never counts for a prepaid plan: it was paid for in full', async () => {
    const { tx, grants } = fakeTx({ open: 9, billingMode: VariantBillingMode.prepaid });

    await issue(tx);

    expect(grants).toHaveLength(1);
    expect(tx.grant.count).not.toHaveBeenCalled();
  });
});
