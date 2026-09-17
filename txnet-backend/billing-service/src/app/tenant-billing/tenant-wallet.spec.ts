/**
 * A reseller reading its own billing wallet (F-019-d, D-41).
 *
 * Every way this goes wrong answers a plausible page:
 *
 *  - **somebody else's wallet.** The read is scoped by the reseller's own
 *    scope on the app pool, where strict RLS stands behind it — never the
 *    cross-tenant pool, where a wrong `tenantId` is a different reseller's
 *    balance, rendered without complaint;
 *  - **a balance added up.** The figure is `cachedBalance` as the ledger
 *    wrote it, not a sum of the rows on the page (invariant 3);
 *  - **the wrong door.** The same one as the top-up: a reseller's owner, or
 *    its staff holding `tenant_billing.topup`. A customer of the reseller, and
 *    the platform owner, which has no billing wallet, are refused before the
 *    wallet is read.
 */
import { Prisma, TenantBillingReasonType, TenantLedgerDirection, TenantType } from '@prisma/client';
import { TenantContext, runWithTenant } from '@txnet-backend/shared-core';

import { TENANT_BILLING_TOPUP, TenantTopupRefused } from './tenant-topup.service';
import { TenantWalletService } from './tenant-wallet.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const WALLET = '33333333-3333-4333-8333-333333333333';
const RESELLER_OWNER_USER = '44444444-4444-4444-8444-444444444444';
const STAFF = '55555555-5555-4555-8555-555555555555';

const d = (v: string) => new Prisma.Decimal(v);

function build({ hasWallet = true } = {}) {
  const tenants = new Map([
    [OWNER, { tenantType: TenantType.platform_owner, ownerUserId: 'x' }],
    [RESELLER, { tenantType: TenantType.reseller, ownerUserId: RESELLER_OWNER_USER }],
  ]);
  const reads: Array<{ scope: string; what: string; where: unknown }> = [];
  const rows = [
    {
      id: 'b',
      amount: d('40'),
      direction: TenantLedgerDirection.debit,
      reasonType: TenantBillingReasonType.admin_manual_adjust,
      balanceAfter: d('60'),
      createdAt: new Date('2026-09-17T10:00:00Z'),
    },
    {
      id: 'a',
      amount: d('100'),
      direction: TenantLedgerDirection.credit,
      reasonType: TenantBillingReasonType.topup_payment,
      balanceAfter: d('100'),
      createdAt: new Date('2026-09-16T10:00:00Z'),
    },
  ];
  const tx = {
    $executeRaw: async () => 0,
    tenantBillingWallet: {
      findUnique: async (args: { where: unknown }) => {
        reads.push({ scope: TenantContext.current().id, what: 'wallet', where: args.where });
        // A deliberately different figure from the rows' last balanceAfter: the
        // header is the wallet's, not the page's.
        return hasWallet ? { id: WALLET, cachedBalance: d('75.5') } : null;
      },
    },
    tenantBillingTransaction: {
      findMany: async (args: { where: unknown; skip: number; take: number }) => {
        reads.push({ scope: TenantContext.current().id, what: 'rows', where: args });
        return rows.slice(args.skip, args.skip + args.take);
      },
      count: async () => rows.length,
    },
  };
  const prisma = {
    tenant: { findUnique: async ({ where }: { where: { id: string } }) => tenants.get(where.id) ?? null },
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  return { service: new TenantWalletService(prisma as never), reads };
}

const asReseller = <T>(fn: () => Promise<T>) => runWithTenant({ id: RESELLER }, fn);
const owner = { userId: RESELLER_OWNER_USER, tenantId: RESELLER, permissions: [] };

describe("a reseller's billing wallet, read", () => {
  it("answers the wallet's own balance and its movements, newest first, in the reseller's scope", async () => {
    const { service, reads } = build();
    const page = await asReseller(() => service.history(owner, { page: 1, pageSize: 20 }));

    expect(page).toEqual({
      balance: '75.50',
      total: 2,
      page: 1,
      pageSize: 20,
      rows: [
        {
          id: 'b',
          amount: '40.00',
          direction: 'debit',
          reasonType: 'admin_manual_adjust',
          balanceAfter: '60.00',
          createdAt: new Date('2026-09-17T10:00:00Z'),
        },
        {
          id: 'a',
          amount: '100.00',
          direction: 'credit',
          reasonType: 'topup_payment',
          balanceAfter: '100.00',
          createdAt: new Date('2026-09-16T10:00:00Z'),
        },
      ],
    });
    expect(reads.map((r) => r.scope)).toEqual([RESELLER, RESELLER]);
    expect(reads[0].where).toEqual({ tenantId: RESELLER });
    expect(reads[1].where).toMatchObject({
      where: { walletId: WALLET },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('pages, and a reseller with no wallet yet has a zero balance rather than a 404', async () => {
    const second = await asReseller(() => build().service.history(owner, { page: 2, pageSize: 1 }));
    expect(second.rows.map((r) => r.id)).toEqual(['a']);

    const { service, reads } = build({ hasWallet: false });
    const empty = await asReseller(() => service.history(owner, {}));
    expect(empty).toEqual({ balance: '0.00', total: 0, page: 1, pageSize: 20, rows: [] });
    expect(reads.map((r) => r.what)).toEqual(['wallet']);
  });

  it('admits a staff member only with tenant_billing.topup, and reads nothing before', async () => {
    const { service, reads } = build();
    const staff = (permissions: string[]) => ({ userId: STAFF, tenantId: RESELLER, permissions });

    await expect(asReseller(() => service.history(staff([]), {}))).rejects.toMatchObject({ reason: 'not_permitted' });
    expect(reads).toEqual([]);

    await asReseller(() => service.history(staff([TENANT_BILLING_TOPUP]), {}));
    expect(reads).toHaveLength(2);
  });

  it('refuses the platform owner: it has no billing wallet', async () => {
    const { service, reads } = build();
    const refused = runWithTenant({ id: OWNER }, () =>
      service.history({ userId: 'x', tenantId: OWNER, permissions: ['*'] }, {}),
    );

    await expect(refused).rejects.toBeInstanceOf(TenantTopupRefused);
    await expect(refused).rejects.toMatchObject({ reason: 'not_a_reseller' });
    expect(reads).toEqual([]);
  });
});
