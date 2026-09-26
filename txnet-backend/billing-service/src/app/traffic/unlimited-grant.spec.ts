/**
 * An unlimited Grant (F-111-q) — sold with `traffic_bytes.limit = 0`, carried
 * as `grant.trafficUnlimited`, never as the number.
 *
 * Everywhere downstream of the catalog 0 means *empty*, so what breaks without
 * the flag is quiet:
 *  - **a 0-byte ceiling on every config.** The allocator splits a bag of 0,
 *    and the panel is told the user may carry nothing (F-111-r places them);
 *  - **suspended at the first byte.** A spent bag is `consumed ≥ purchased`,
 *    which an empty bag is from the start;
 *  - **a block bought for traffic that was never metered.** The hot loop sizes
 *    a block for any Grant inside its horizon, and a 0 bag is always inside.
 * Usage is not in here: the delta consumer increments `consumedBytes` for every
 * Grant alike (metering-service), which is what keeps the panel's figure true.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GrantSource, GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';

import { grantFromVariant } from '../entitlement/grant';
import { CeilingAllocatorService } from './ceiling-allocator';
import { suspendIfExhausted } from './exhaustion';
import { HotLoopService } from './horizon';

const GRANT = '77777777-7777-4777-8777-777777777777';
const USER = '44444444-4444-4444-8444-444444444444';
const GB = BigInt(1024 ** 3);

const unlimitedGrant = {
  id: GRANT,
  userId: USER,
  status: GrantStatus.active,
  billingMode: VariantBillingMode.prepaid,
  meteredRate: null,
  purchasedBytes: BigInt(0),
  consumedBytes: BigInt(5) * GB,
  trafficUnlimited: true,
};

/** A transaction whose every write is recorded, and whose Grant is `unlimitedGrant`. */
function fakeTx() {
  const writes: string[] = [];
  const config = { id: 'c1', allocatedCeilingBytes: null, walletBackedCeilingBytes: null, observedRateBps: BigInt(8) * GB, counterState: null, subAccount: null, panel: { maxLineRateBps: null } };
  const tx = {
    grant: {
      findUnique: async () => unlimitedGrant,
      updateMany: async () => {
        writes.push('grant');
        return { count: 1 };
      },
    },
    config: {
      findMany: async () => [config],
      update: async () => {
        writes.push('config');
        return config;
      },
      updateMany: async () => {
        writes.push('config');
        return { count: 1 };
      },
    },
    wallet: { findUnique: async () => ({ cachedBalance: new Prisma.Decimal('1000') }) },
    $queryRaw: async () => [{ cachedBalance: new Prisma.Decimal('0') }],
  };
  return { tx: tx as unknown as Prisma.TransactionClient, writes };
}

describe('an unlimited Grant', () => {
  const variant = {
    billingMode: VariantBillingMode.prepaid,
    quotas: { traffic_bytes: { limit: 0, resetPolicy: 'none' } },
    durationDays: 30,
    meteredRates: [],
    product: { featureKeys: ['vpn.access'] },
  };
  const start = { source: GrantSource.purchase, startsAt: new Date('2026-09-26T10:00:00Z') };

  it('is flagged at issue from a sold 0, with an empty bag, never 0-as-unlimited', () => {
    const g = grantFromVariant(start, variant);
    expect(g.trafficUnlimited).toBe(true);
    expect(g.purchasedBytes).toBe(BigInt(0));
  });

  it('is not flagged from a limit, from no traffic row, or for a metered variant', () => {
    expect(grantFromVariant(start, { ...variant, quotas: { traffic_bytes: { limit: 1024 } } }).trafficUnlimited).toBe(false);
    expect(grantFromVariant(start, { ...variant, quotas: {} }).trafficUnlimited).toBe(false);
    expect(grantFromVariant(start, { ...variant, billingMode: VariantBillingMode.metered }).trafficUnlimited).toBe(false);
  });

  it('is held by the database to a prepaid Grant with an empty bag', () => {
    const migrations = join(__dirname, '../../../../prisma/domains/migrations');
    const sql = readdirSync(migrations, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        try {
          return readFileSync(join(migrations, e.name, 'migration.sql'), 'utf8');
        } catch {
          return '';
        }
      })
      .join('\n');
    expect(sql).toContain('"trafficUnlimited" BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toMatch(/grant_traffic_unlimited_is_prepaid[\s\S]*"billingMode" = 'prepaid'[\s\S]*"purchasedBytes" = 0/);
  });

  it('gets no ceiling: nothing is split and nothing written', async () => {
    const { tx, writes } = fakeTx();
    const out = await new CeilingAllocatorService({} as never).rebalance(tx, { grantId: GRANT });
    expect(out.unlimited).toBe(true);
    expect(out.ceilings).toEqual([]);
    expect(out.written).toBe(0);
    expect(writes).toEqual([]);
  });

  it('is never suspended as exhausted, however far past its empty bag', async () => {
    const { tx, writes } = fakeTx();
    const out = await suspendIfExhausted(tx, GRANT, new Date('2026-09-26T10:00:00Z'));
    expect(out.verdict).toBe('unlimited');
    expect(writes).toEqual([]);
  });

  it('never buys a block and never asks exhaustion, even running hot', async () => {
    const { tx, writes } = fakeTx();
    const purchases: unknown[] = [];
    const blocks = { purchase: async (_tx: unknown, input: unknown) => void purchases.push(input) };
    const ceilings = { rebalance: async () => void writes.push('rebalance') };
    const hot = new HotLoopService({} as never, blocks as never, ceilings as never);
    const out = await hot.topUpIn(tx, { grantId: GRANT, atMs: Date.parse('2026-09-26T10:00:00Z') });
    expect(purchases).toEqual([]);
    expect(out.bought).toBeNull();
    expect(out.exhausted).toBeNull();
    expect(writes).toEqual([]);
  });
});
