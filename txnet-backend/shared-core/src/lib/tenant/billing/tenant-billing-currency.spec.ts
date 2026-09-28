import { Prisma, TenantBillingReasonType, TenantType } from '@prisma/client';

import {
  TenantBillingCurrencyMismatch,
  TenantBillingEntry,
  TenantBillingLedger,
} from './tenant-billing-ledger';

/**
 * F-116-g — money between a reseller and the platform is in the platform's
 * currency (ADR-0098 part 4, tenant `contract.billing.md`).
 *
 * A reseller keeps its own books in its operating currency, but its billing
 * wallet is the platform's money. Every writer (adjustment, top-up, purchase,
 * renewal) names no currency or the platform's, so what this file holds is the
 * ledger's side of the boundary: the reseller's own currency is never read, a
 * movement in it is refused before anything is written, and the one amount
 * allowed across — a credit priced before the **platform's** change — is
 * converted at that change and records what it was.
 */
const PLATFORM = '11111111-1111-1111-1111-111111111111';
const RESELLER = '44444444-4444-4444-4444-444444444444';
const WALLET = '55555555-5555-5555-5555-555555555555';

function build(opts: { wallet?: boolean; changes?: { fromCode: string; toCode: string; rate: string }[] } = {}) {
  const writes: string[] = [];
  const tenantReads: unknown[] = [];
  let wallet =
    opts.wallet === false
      ? null
      : { id: WALLET, tenantId: RESELLER, cachedBalance: new Prisma.Decimal('100.00'), version: 3, currencyCode: 'USD' };
  const tx = {
    tenant: {
      findFirst: vi.fn(async (args: { where: { tenantType?: TenantType } }) => {
        tenantReads.push(args.where);
        // Only the platform owner's row exists to be read: a lookup of the reseller answers nothing.
        return args.where.tenantType === TenantType.platform_owner ? { id: PLATFORM, operatingCurrencyCode: 'USD' } : null;
      }),
    },
    tenantBillingTransaction: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push('row'), { id: 'tx-1', ...data })),
    },
    tenantBillingWallet: {
      findUnique: vi.fn(async () => wallet),
      findUniqueOrThrow: vi.fn(async () => wallet),
      createMany: vi.fn(async ({ data }: { data: { tenantId: string; currencyCode: string }[] }) => {
        writes.push('wallet.open');
        wallet = { id: WALLET, tenantId: data[0].tenantId, cachedBalance: new Prisma.Decimal(0), version: 0, currencyCode: data[0].currencyCode };
        return { count: 1 };
      }),
      updateMany: vi.fn(async () => (writes.push('wallet.balance'), { count: 1 })),
    },
    currencyChange: { findMany: vi.fn(async () => opts.changes ?? []) },
    currency: { findUnique: vi.fn(async () => ({ decimalPlaces: 2 })) },
    outboxEvent: { create: vi.fn(async () => (writes.push('outbox'), {})) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, raw: tx, writes, tenantReads };
}

const entry = (over: Partial<TenantBillingEntry> = {}): TenantBillingEntry => ({
  tenantId: RESELLER,
  amount: new Prisma.Decimal('10.00'),
  reasonType: TenantBillingReasonType.subscription_charge,
  referenceId: 'period-1',
  ...over,
});

describe('TenantBillingLedger — the tenant <-> platform boundary is in the platform currency', () => {
  const ledger = new TenantBillingLedger();

  it('charges a reseller that keeps its books in IRR in the wallet currency, and never reads the reseller currency', async () => {
    const { tx, raw, tenantReads } = build();

    await ledger.debit(tx, entry());

    const row = raw.tenantBillingTransaction.create.mock.calls[0][0].data;
    expect(row).toMatchObject({ currencyCode: 'USD', amount: new Prisma.Decimal('10.00') });
    expect(row).not.toHaveProperty('sourceCurrencyCode');
    expect(tenantReads).toEqual([]);
  });

  it('refuses a debit in the reseller own currency before anything is written', async () => {
    const { tx, writes } = build();

    await expect(ledger.debit(tx, entry({ currencyCode: 'IRR' }))).rejects.toBeInstanceOf(TenantBillingCurrencyMismatch);
    expect(writes).toEqual([]);
  });

  it('refuses a credit in a currency no platform change leads from', async () => {
    const { tx, writes } = build({ changes: [{ fromCode: 'EUR', toCode: 'USD', rate: '1.1' }] });

    await expect(
      ledger.credit(tx, entry({ currencyCode: 'IRR', reasonType: TenantBillingReasonType.topup_payment })),
    ).rejects.toBeInstanceOf(TenantBillingCurrencyMismatch);
    expect(writes).toEqual([]);
  });

  it('converts a credit priced before the platform changed currency and records what it was', async () => {
    const { tx, raw } = build({ changes: [{ fromCode: 'EUR', toCode: 'USD', rate: '1.1' }] });

    await ledger.credit(tx, entry({ currencyCode: 'EUR', reasonType: TenantBillingReasonType.topup_payment }));

    expect(raw.currencyChange.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: PLATFORM } }));
    expect(raw.tenantBillingTransaction.create.mock.calls[0][0].data).toMatchObject({
      currencyCode: 'USD',
      amount: new Prisma.Decimal('11.00'),
      sourceAmount: new Prisma.Decimal('10.00'),
      sourceCurrencyCode: 'EUR',
    });
  });

  it('opens a first wallet in the platform currency whatever the entry names', async () => {
    const { tx, raw } = build({ wallet: false, changes: [{ fromCode: 'EUR', toCode: 'USD', rate: '1.1' }] });

    await ledger.credit(tx, entry({ currencyCode: 'EUR', reasonType: TenantBillingReasonType.reseller_purchase }));

    expect(raw.tenantBillingWallet.createMany.mock.calls[0][0].data[0]).toMatchObject({ tenantId: RESELLER, currencyCode: 'USD' });
  });
});
