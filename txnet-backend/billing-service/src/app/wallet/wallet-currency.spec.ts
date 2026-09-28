import { Prisma } from '@prisma/client';
import { LedgerCurrencyMismatch, operatingCurrencyOf, platformCurrencyOf } from '@txnet-backend/shared-core';

import { WalletLedgerService } from './wallet-ledger.service';

/**
 * Every ledger row is in its wallet's currency (F-116-b, ADR-0098 part 3).
 *
 * A tenant's operating currency can change (F-116-f), so a row's currency is
 * never derived from its tenant: the wallet records the currency it opened in,
 * each ledger row records the currency its amount is in, and the two must be
 * the same. Without the check a 10 EUR credit lands in a USD wallet as 10 USD,
 * and the ledger reads consistent row by row.
 */
const D = (v: string | number) => new Prisma.Decimal(v);

function fakeStore() {
  const wallets = new Map<string, { id: string; ownerUserId: string; currencyCode: string; cachedBalance: Prisma.Decimal; version: number }>();
  const ledger: Array<Record<string, unknown>> = [];
  const outbox: Array<Record<string, unknown>> = [];
  const tx = {
    wallet: {
      findUnique: async ({ where }: { where: { ownerUserId: string } }) => {
        const row = wallets.get(where.ownerUserId);
        return row ? { ...row } : null;
      },
      findUniqueOrThrow: async ({ where }: { where: { ownerUserId: string } }) => ({ ...wallets.get(where.ownerUserId)! }),
      createMany: async ({ data }: { data: Array<{ ownerUserId: string; currencyCode: string }> }) => {
        for (const { ownerUserId, currencyCode } of data) {
          if (!wallets.has(ownerUserId)) {
            wallets.set(ownerUserId, { id: `wallet-${ownerUserId}`, ownerUserId, currencyCode, cachedBalance: D(0), version: 0 });
          }
        }
        return { count: data.length };
      },
      updateMany: async ({ where, data }: { where: { id: string; version: number }; data: { cachedBalance: Prisma.Decimal } }) => {
        const row = [...wallets.values()].find((w) => w.id === where.id && w.version === where.version);
        if (!row) return { count: 0 };
        row.cachedBalance = data.cachedBalance;
        row.version += 1;
        return { count: 1 };
      },
    },
    walletTransaction: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `ledger-${ledger.length + 1}`, tenantId: 'tenant-a', ...data };
        ledger.push(row);
        return row;
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        outbox.push(data);
        return data;
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, wallets, ledger, outbox };
}

describe('the wallet ledger and currency (F-116-b)', () => {
  it('opens a wallet in the currency of its first credit, and the row records it', async () => {
    const { tx, wallets, ledger } = fakeStore();
    const ledgerService = new WalletLedgerService();

    await ledgerService.credit(tx, { userId: 'u1', amount: D('10.00'), currencyCode: 'EUR', reasonType: 'payment_gateway' });

    expect(wallets.get('u1')?.currencyCode).toBe('EUR');
    expect(ledger).toEqual([expect.objectContaining({ currencyCode: 'EUR', amount: D('10.00') })]);
  });

  it.each(['credit', 'debit'] as const)('refuses a %s in another currency than the wallet’s, writing nothing', async (direction) => {
    const { tx, wallets, ledger, outbox } = fakeStore();
    const ledgerService = new WalletLedgerService();
    await ledgerService.credit(tx, { userId: 'u1', amount: D('10.00'), currencyCode: 'USD', reasonType: 'payment_gateway' });

    await expect(
      ledgerService[direction](tx, { userId: 'u1', amount: D('5.00'), currencyCode: 'EUR', reasonType: 'product_purchase' }),
    ).rejects.toThrow(LedgerCurrencyMismatch);

    expect(wallets.get('u1')).toMatchObject({ cachedBalance: D('10.00'), version: 1 });
    expect(ledger).toHaveLength(1);
    expect(outbox).toHaveLength(1);
  });

  it('moves money in the wallet’s own currency as before', async () => {
    const { tx, wallets } = fakeStore();
    const ledgerService = new WalletLedgerService();
    await ledgerService.credit(tx, { userId: 'u1', amount: D('10.00'), currencyCode: 'IRR', reasonType: 'payment_gateway' });
    const movement = await ledgerService.debit(tx, { userId: 'u1', amount: D('4.00'), currencyCode: 'IRR', reasonType: 'product_purchase' });

    expect(movement.balanceAfter).toEqual(D('6.00'));
    expect(wallets.get('u1')?.cachedBalance).toEqual(D('6.00'));
  });
});

describe('where a new money row takes its currency from (F-116-b)', () => {
  const tenants = [
    { id: 'platform', tenantType: 'platform_owner', operatingCurrencyCode: 'USD' },
    { id: 'reseller-eu', tenantType: 'reseller', operatingCurrencyCode: 'EUR' },
  ];
  const tx = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => tenants.find((t) => t.id === where.id) ?? null,
      findFirst: async ({ where }: { where: { tenantType: string } }) => tenants.find((t) => t.tenantType === where.tenantType) ?? null,
    },
  } as unknown as Prisma.TransactionClient;

  it('is the tenant’s operating currency at the moment of writing', async () => {
    await expect(operatingCurrencyOf(tx, 'reseller-eu')).resolves.toBe('EUR');
  });

  it('is the platform owner’s for the platform’s own rows', async () => {
    await expect(platformCurrencyOf(tx)).resolves.toBe('USD');
  });

  it('refuses a tenant that does not exist rather than guessing USD', async () => {
    await expect(operatingCurrencyOf(tx, 'nobody')).rejects.toThrow(/nobody/);
  });
});
