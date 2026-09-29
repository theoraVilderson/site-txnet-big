/**
 * An admin gifts bytes to a metered Grant (F-311-l, spec F-311). What would
 * break quietly here, and nowhere else:
 *
 *  - **a gift is bought by nobody.** `purchasedBytes` rises — the planner's
 *    Quota, so no block is bought while the gift lasts — and `billedBytes`,
 *    the money cursor, does not move; no wallet row is written;
 *  - **the remainder credit never pays a gift out as money.** It gives back
 *    `billedBytes - consumedBytes` at close (F-027-r), so a gift that never
 *    reached the money cursor is never in it: a Grant closed with gifted bytes
 *    unused gets back what it paid for and did not use, and not a cent more;
 *  - **its own source**: the `quota_adjustment` row says `admin_gift`, so a
 *    gift is never read back as a prepaid admin move or a purchase;
 *  - **only a metered Grant** takes one (a prepaid bag is moved by F-311-j),
 *    and only while `active` or `suspended`; a raise past Used revives one
 *    suspended because its bag was spent;
 *  - **the write is conditional on the bag read** — a block bought in
 *    between is `grant_moved`, never a gift added to a figure nobody saw.
 */
import { GrantSource, GrantStatus, Prisma, QuotaMetric, VariantBillingMode } from '@prisma/client';

import { EntitlementRefused } from '../entitlement/grant';
import { QUOTA_EXHAUSTED } from '../entitlement/suspension';
import { WalletCreditService } from '../wallet/wallet-credit.service';
import { WalletLedgerService } from '../wallet/wallet-ledger.service';
import { giftGrantBytes } from './gift-bytes';
import { RemainderCreditService } from './remainder-credit';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999991';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const GIB = BigInt(1024 ** 3);
const DAY = 86_400_000;
const AT = new Date('2026-09-28T10:00:00.000Z');
const D = (v: string) => new Prisma.Decimal(v);

type Row = {
  id: string;
  tenantId: string;
  userId: string;
  status: GrantStatus;
  statusReason: string | null;
  suspendedAt: Date | null;
  billingMode: VariantBillingMode;
  trafficUnlimited: boolean;
  meteredRate: Prisma.Decimal | null;
  meteredRateCurrencyCode: string | null;
  purchasedBytes: bigint;
  billedBytes: bigint;
  consumedBytes: bigint;
  endsAt: Date | null;
};

/** One store both the gift and the remainder credit run against; Used (Σ counters) follows `consumedBytes`. */
function build(row: Partial<Row>, balance = D('1.00')) {
  const grant: Row = {
    id: GRANT,
    tenantId: TENANT,
    userId: USER,
    status: GrantStatus.active,
    statusReason: null,
    suspendedAt: null,
    billingMode: VariantBillingMode.metered,
    trafficUnlimited: false,
    meteredRate: D('0.40000000'),
    meteredRateCurrencyCode: 'USD',
    purchasedBytes: GIB,
    billedBytes: GIB,
    consumedBytes: GIB,
    endsAt: new Date(AT.getTime() + 10 * DAY),
    ...row,
  };
  const wallet = { id: 'wallet-1', ownerUserId: USER, currencyCode: 'USD', cachedBalance: balance, heldAmount: new Prisma.Decimal(0), version: 0 };
  const ledger: Array<Record<string, unknown>> = [];
  const adjustments: Array<Record<string, unknown>> = [];
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const matches = (where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => (grant as Record<string, unknown>)[k] === v);

  const tx = {
    // Every tenant here keeps its books in USD (F-116-b).
    tenant: { findUnique: async () => ({ operatingCurrencyCode: 'USD' }), findFirst: async () => ({ operatingCurrencyCode: 'USD' }) },
    grant: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === grant.id ? { ...grant } : null),
      findMany: async () => [],
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.push({ where, data });
        if (!matches(where)) return { count: 0 };
        for (const [k, v] of Object.entries(data)) {
          const cur = (grant as Record<string, unknown>)[k];
          (grant as Record<string, unknown>)[k] = v && typeof v === 'object' && 'decrement' in v ? (cur as bigint) - (v as { decrement: bigint }).decrement : v;
        }
        return { count: 1 };
      },
    },
    config: {
      findMany: async () => [{ counterState: { lifetimeUpBytes: BigInt(0), lifetimeDownBytes: grant.consumedBytes } }],
      updateMany: async () => ({ count: 1 }),
    },
    quotaAdjustment: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        adjustments.push(data);
        return { id: 'adjustment-1' };
      },
    },
    leaseClose: { findUnique: async () => null },
    // No reserve held: the release (F-118-b) writes nothing; vpn-reserve.spec.ts holds it.
    walletHold: { findFirst: async () => null },
    wallet: {
      findUnique: async () => ({ ...wallet }),
      findUniqueOrThrow: async () => ({ ...wallet }),
      createMany: async () => ({ count: 0 }),
      updateMany: async ({ where, data }: { where: { id: string; version: number }; data: { cachedBalance: Prisma.Decimal; version: { increment: number } } }) => {
        if (where.id !== wallet.id || where.version !== wallet.version) return { count: 0 };
        wallet.cachedBalance = data.cachedBalance;
        wallet.version += data.version.increment;
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
    outboxEvent: { create: async ({ data }: { data: Record<string, unknown> }) => data },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, grant, wallet, ledger, adjustments, writes };
}

const gift = (bytes: bigint, reason = 'outage 2026-09-27') => ({ at: AT, actorUserId: ADMIN, bytes, reason });
const credit = (tx: Prisma.TransactionClient) =>
  new RemainderCreditService({} as never, new WalletCreditService(new WalletLedgerService())).credit(tx, { grantId: GRANT });

describe('giftGrantBytes (F-311-l)', () => {
  it('raises the bag, leaves the money cursor, and writes no wallet row', async () => {
    const { tx, grant, ledger, wallet, adjustments } = build({});

    const done = await giftGrantBytes(tx, GRANT, gift(BigInt(5) * GIB));

    expect(grant.purchasedBytes).toBe(BigInt(6) * GIB);
    expect(grant.billedBytes).toBe(GIB);
    expect(ledger).toHaveLength(0);
    expect(wallet.cachedBalance.toFixed(2)).toBe('1.00');
    expect(done).toMatchObject({ adjustmentId: 'adjustment-1', purchasedBytesBefore: GIB, purchasedBytesAfter: BigInt(6) * GIB, usedBytes: GIB, spent: false });
    expect(adjustments).toEqual([
      expect.objectContaining({ tenantId: TENANT, grantId: GRANT, metric: QuotaMetric.traffic_bytes, delta: BigInt(5) * GIB, source: GrantSource.admin_gift, reason: 'outage 2026-09-27', createdByAdminId: ADMIN }),
    ]);
  });

  it('pays nothing back for a gift the Grant closed without using', async () => {
    // 1 GiB bought and served, 5 GiB gifted, 2 of them served, then it expires.
    const { tx, grant, ledger, wallet } = build({});
    await giftGrantBytes(tx, GRANT, gift(BigInt(5) * GIB));
    grant.consumedBytes = BigInt(3) * GIB;
    grant.status = GrantStatus.expired;

    await expect(credit(tx)).rejects.toMatchObject({ reason: 'nothing_to_credit' });
    expect(ledger).toHaveLength(0);
    expect(wallet.cachedBalance.toFixed(2)).toBe('1.00');
  });

  it('gives back what was paid for and unused, and not a cent of the gift', async () => {
    // 2 GiB bought, 1 served, then 5 GiB gifted and the Grant cancelled: 1 GiB at 40c back, never 6.
    const { tx, grant, wallet } = build({ purchasedBytes: BigInt(2) * GIB, billedBytes: BigInt(2) * GIB });
    await giftGrantBytes(tx, GRANT, gift(BigInt(5) * GIB));
    grant.status = GrantStatus.cancelled;

    const back = await credit(tx);

    expect(back.amount.toFixed(2)).toBe('0.40');
    expect(wallet.cachedBalance.toFixed(2)).toBe('1.40');
  });

  it('revives a Grant suspended because its bag was spent', async () => {
    const { tx, grant } = build({ status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED, suspendedAt: new Date(AT.getTime() - DAY) });

    const done = await giftGrantBytes(tx, GRANT, gift(GIB));

    expect(done.revived).toBe(true);
    expect(grant.status).toBe(GrantStatus.active);
  });

  it.each([
    ['a prepaid Grant', { billingMode: VariantBillingMode.prepaid }, 'grant_not_metered'],
    ['an unlimited one', { trafficUnlimited: true }, 'grant_not_metered'],
    ['a closed one', { status: GrantStatus.expired }, 'grant_closed'],
    ['a pending one', { status: GrantStatus.pending }, 'grant_not_active'],
  ] as const)('refuses %s and writes nothing', async (_label, row, reason) => {
    const { tx, grant, writes, adjustments } = build(row);

    await expect(giftGrantBytes(tx, GRANT, gift(GIB))).rejects.toEqual(expect.objectContaining({ reason }));
    expect(writes).toHaveLength(0);
    expect(adjustments).toHaveLength(0);
    expect(grant.purchasedBytes).toBe(GIB);
  });

  it('is grant_moved when a block was bought between the read and the write', async () => {
    const { tx, grant, adjustments } = build({});
    const findUnique = (tx as unknown as { grant: { findUnique: (a: unknown) => Promise<Row> } }).grant.findUnique;
    (tx as unknown as { grant: { findUnique: (a: unknown) => Promise<Row> } }).grant.findUnique = async (a) => {
      const read = await findUnique(a);
      grant.purchasedBytes += GIB; // the block's increment lands after the read
      return read;
    };

    await expect(giftGrantBytes(tx, GRANT, gift(GIB))).rejects.toBeInstanceOf(EntitlementRefused);
    expect(adjustments).toHaveLength(0);
  });

  it('refuses a gift of nothing', async () => {
    const { tx } = build({});
    await expect(giftGrantBytes(tx, GRANT, gift(BigInt(0)))).rejects.toBeInstanceOf(RangeError);
  });
});
