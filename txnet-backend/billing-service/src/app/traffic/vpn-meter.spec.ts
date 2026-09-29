/**
 * F-118-l (D-58, ADR-0105 (0)(12), stage 5): a metered Grant's rate and money
 * cursor are its `vpn.traffic` `grant_meter`'s. `meteredRate`,
 * `meteredRateCurrencyCode` and `billedBytes` are gone from the Grant; the
 * block purchaser prices at the meter's `unitPrice` in its `currencyCode` and
 * moves its `billed` and `funded`, the remainder credit brings `billed` down,
 * and `purchasedBytes` stays the bag — so a package plan, which has no meter,
 * never reaches either path.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { GrantStatus, Prisma, RateCardAfterIncluded, RateCardMode, VariantBillingMode, WalletReasonType } from '@prisma/client';

import { WalletCreditService } from '../wallet/wallet-credit.service';
import { WalletLedgerService } from '../wallet/wallet-ledger.service';
import { BlockPurchaseService, GIB } from './block-purchase';
import { RemainderCreditService } from './remainder-credit';

const D = (v: string | number) => new Prisma.Decimal(v);
const USER = '44444444-4444-4444-8444-444444444444';
const GRANT = '77777777-7777-4777-8777-777777777777';

type Meter = { id: string; grantId: string; meterKey: string; unitSize: bigint; unitPrice: Prisma.Decimal; currencyCode: string; mode: RateCardMode; includedQuantity: bigint; afterIncluded: RateCardAfterIncluded; consumed: bigint; billed: bigint; funded: bigint };

function fakeTx(opts: { status?: GrantStatus; billingMode?: VariantBillingMode; meter?: Partial<Meter> | null; consumedBytes?: bigint; balance?: string }) {
  const grant = {
    id: GRANT,
    tenantId: 'tenant-1',
    userId: USER,
    status: opts.status ?? GrantStatus.active,
    billingMode: opts.billingMode ?? VariantBillingMode.metered,
    purchasedBytes: BigInt(0),
    consumedBytes: opts.consumedBytes ?? BigInt(0),
    trafficUnlimited: false,
  };
  const meter: Meter | null =
    opts.meter === null
      ? null
      : {
          id: 'meter-1',
          grantId: GRANT,
          meterKey: 'vpn.traffic',
          unitSize: GIB,
          unitPrice: D('0.40000000'),
          currencyCode: 'EUR',
          mode: RateCardMode.prepaid,
          includedQuantity: BigInt(0),
          afterIncluded: RateCardAfterIncluded.metered,
          consumed: BigInt(0),
          billed: BigInt(0),
          funded: BigInt(0),
          ...opts.meter,
        };
  const wallet = { id: 'wallet-1', ownerUserId: USER, currencyCode: 'EUR', cachedBalance: D(opts.balance ?? '10.00'), heldAmount: D(0), version: 0 };
  const ledger: Array<Record<string, unknown>> = [];
  const grantWrites: Array<Record<string, unknown>> = [];

  const bump = (data: Record<string, { increment?: bigint; decrement?: bigint }>) => {
    if (!meter) throw new Error('no meter');
    for (const k of ['billed', 'funded'] as const) {
      if (data[k]?.increment !== undefined) meter[k] += data[k].increment as bigint;
      if (data[k]?.decrement !== undefined) meter[k] -= data[k].decrement as bigint;
    }
  };

  const tx = {
    tenant: { findUnique: async () => ({ operatingCurrencyCode: 'EUR' }), findFirst: async () => ({ operatingCurrencyCode: 'EUR' }) },
    grant: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === GRANT ? { ...grant } : null),
      // A credit revives what the new balance funds (`WalletCreditService`): nothing is suspended here.
      findMany: async () => [],
      update: async ({ data }: { data: Record<string, { increment: bigint }> }) => {
        grantWrites.push(data);
        grant.purchasedBytes += data['purchasedBytes']?.increment ?? BigInt(0);
        return { ...grant };
      },
    },
    grantMeter: {
      findUnique: async ({ where }: { where: { grantId_meterKey: { grantId: string; meterKey: string } } }) =>
        meter && where.grantId_meterKey.grantId === meter.grantId && where.grantId_meterKey.meterKey === meter.meterKey ? { ...meter } : null,
      update: async ({ data }: { data: Record<string, { increment?: bigint }> }) => {
        bump(data);
        return { ...meter };
      },
      updateMany: async ({ where, data }: { where: { id: string; billed: bigint }; data: Record<string, { decrement?: bigint }> }) => {
        if (!meter || where.id !== meter.id || where.billed !== meter.billed) return { count: 0 };
        bump(data);
        return { count: 1 };
      },
    },
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
    walletHold: { findFirst: async () => null },
    spendingCap: { findUnique: async () => null },
    walletTransaction: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `ledger-${ledger.length + 1}`, ...data };
        ledger.push(row);
        return row;
      },
    },
    outboxEvent: { create: async ({ data }: { data: Record<string, unknown> }) => data },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, grant, meter, wallet, ledger, grantWrites };
}

describe('F-118-l: the block purchaser reads the Grant’s vpn.traffic meter', () => {
  const buy = (tx: Prisma.TransactionClient) => new BlockPurchaseService({} as never, new WalletLedgerService()).purchase(tx, { grantId: GRANT, targetBytes: GIB });

  it('prices at the meter’s unitPrice, debits in its currency, and moves billed, funded and the bag by one block', async () => {
    const { tx, grant, meter, ledger } = fakeTx({});

    const block = await buy(tx);

    expect(block.amount.toFixed(2)).toBe('0.40');
    expect(ledger[0]).toMatchObject({ currencyCode: 'EUR', reasonType: WalletReasonType.traffic_consumption, referenceId: GRANT });
    expect(meter?.billed).toBe(block.bytes);
    expect(meter?.funded).toBe(block.bytes);
    expect(grant.purchasedBytes).toBe(block.bytes);
  });

  it('never writes a money cursor onto the Grant: only the bag moves there', async () => {
    const { tx, grantWrites } = fakeTx({});
    await buy(tx);
    expect(grantWrites).toEqual([{ purchasedBytes: { increment: expect.any(BigInt) } }]);
  });

  it('refuses a Grant with no vpn.traffic meter as not metered — a package plan never reaches it (decision 0)', async () => {
    const { tx, ledger } = fakeTx({ billingMode: VariantBillingMode.prepaid, meter: null });
    await expect(buy(tx)).rejects.toMatchObject({ reason: 'grant_not_metered' });
    expect(ledger).toHaveLength(0);
  });

  it('refuses a postpaid meter a block, as F-118-k does', async () => {
    const { tx } = fakeTx({ meter: { mode: RateCardMode.postpaid } });
    await expect(buy(tx)).rejects.toMatchObject({ reason: 'grant_postpaid' });
  });
});

describe('F-118-l: the remainder credit settles on the meter’s billed cursor', () => {
  const credit = (tx: Prisma.TransactionClient) => new RemainderCreditService({} as never, new WalletCreditService(new WalletLedgerService())).credit(tx, { grantId: GRANT });

  it('gives back billed − consumed at the meter’s rate, in its currency, and brings billed down by what it paid for', async () => {
    const { tx, meter, ledger } = fakeTx({ status: GrantStatus.expired, meter: { billed: GIB, funded: GIB }, consumedBytes: GIB / BigInt(2) });

    const back = await credit(tx);

    expect(back.amount.toFixed(2)).toBe('0.20');
    expect(ledger[0]).toMatchObject({ currencyCode: 'EUR', reasonType: WalletReasonType.traffic_refund });
    expect(meter?.billed).toBe(GIB - back.bytes);
    await expect(credit(tx)).rejects.toMatchObject({ reason: 'nothing_to_credit' });
  });

  it('refuses a closed Grant with no meter as not metered', async () => {
    const { tx } = fakeTx({ status: GrantStatus.expired, billingMode: VariantBillingMode.prepaid, meter: null });
    await expect(credit(tx)).rejects.toMatchObject({ reason: 'grant_not_metered' });
  });
});

describe('F-118-l: the columns retire into grant_meter', () => {
  const root = join(__dirname, '../../../../prisma/domains');
  const migrationDir = readdirSync(join(root, 'migrations')).find((d) => d.endsWith('_a_grants_rate_is_its_meters'));
  const sql = migrationDir ? readFileSync(join(root, 'migrations', migrationDir, 'migration.sql'), 'utf8') : '';
  const entitlement = readFileSync(join(root, 'entitlement.prisma'), 'utf8');
  const catalog = readFileSync(join(root, 'catalog.prisma'), 'utf8');

  it('backfills a meter for every metered Grant sold before F-118-e, carrying its billed cursor', () => {
    expect(sql).toMatch(/INSERT INTO "entitlement"\."grant_meter"[\s\S]*?"meteredRate"[\s\S]*?"billedBytes"[\s\S]*?WHERE[\s\S]*?NOT EXISTS/);
  });

  it('moves the billed cursor of a Grant that already had its meter', () => {
    expect(sql).toMatch(/UPDATE "entitlement"\."grant_meter"[\s\S]*?"billed" = g\."billedBytes"/);
  });

  it('drops the three Grant columns and the retired metered_rate table', () => {
    for (const col of ['meteredRate', 'meteredRateCurrencyCode', 'billedBytes']) {
      expect(sql).toContain(`DROP COLUMN "${col}"`);
      expect(entitlement).not.toMatch(new RegExp(`^\\s+${col}\\s`, 'm'));
    }
    expect(sql).toContain('DROP TABLE "catalog"."metered_rate"');
    expect(catalog).not.toContain('model MeteredRate');
  });

  it('keeps the bag and the measured counter non-negative once the combined CHECK goes with billedBytes', () => {
    expect(sql).toMatch(/CHECK \("consumedBytes" >= 0 AND "purchasedBytes" >= 0\)/);
  });

  it('lets a meter’s price change only with its currency — a conversion, never a reprice', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION entitlement\.grant_meter_terms_are_locked\(\)[\s\S]*?NEW\."currencyCode" = OLD\."currencyCode"/);
  });

  it('holds a vpn.traffic meter to the shape the byte engine serves', () => {
    expect(sql).toMatch(/"meterKey" <> 'vpn\.traffic' OR \("unitSize" = 1073741824/);
  });
});
