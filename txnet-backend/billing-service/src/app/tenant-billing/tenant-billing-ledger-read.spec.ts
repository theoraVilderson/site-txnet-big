/**
 * The platform owner reads one reseller's billing ledger (F-019-j, D-41).
 *
 * A read is not a write, but this one crosses a tenant boundary, so the ways
 * it breaks are the adjustment's ways:
 *
 *  - **the pool follows the caller (ADR-0053).** Only the platform owner is
 *    served on the cross-tenant pool; a reseller holding the key is refused on
 *    the app pool, before that pool is touched. Without the check this route
 *    hands any reseller any other reseller's ledger for a guessed id;
 *  - **the target is a reseller.** The platform owner has no billing wallet;
 *    an unknown id is a 404, not an empty page that looks like "no movements";
 *  - **a balance added up.** The figure is the wallet's `cachedBalance`
 *    (invariant 3), never a sum of the rows on the page;
 *  - **paging that repeats a row.** Newest first with `id` breaking a
 *    timestamp tie, as the reseller's own read orders it (F-019-d).
 */
import { Prisma, TenantBillingReasonType, TenantLedgerDirection, TenantType } from '@prisma/client';

import { TenantBillingAdminRefused, TenantBillingAdminService } from './tenant-billing-admin.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const MISSING = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const WALLET = '55555555-5555-4555-8555-555555555555';

const d = (v: string) => new Prisma.Decimal(v);

function store({ hasWallet = true } = {}) {
  const tenants = new Map<string, TenantType>([
    [OWNER, TenantType.platform_owner],
    [RESELLER, TenantType.reseller],
  ]);
  const rows = [
    {
      id: 'b',
      amount: d('40'),
      direction: TenantLedgerDirection.debit,
      reasonType: TenantBillingReasonType.subscription_charge,
      referenceId: 'ref-b',
      balanceAfter: d('60'),
      currencyCode: 'USD',
      createdAt: new Date('2026-09-18T10:00:00Z'),
    },
    {
      id: 'a',
      amount: d('100'),
      direction: TenantLedgerDirection.credit,
      reasonType: TenantBillingReasonType.admin_manual_adjust,
      referenceId: 'ref-a',
      balanceAfter: d('100'),
      // Written before the platform switched from EUR: it keeps its own (F-116-h2).
      currencyCode: 'EUR',
      createdAt: new Date('2026-09-17T10:00:00Z'),
    },
  ];
  const queries: Array<Record<string, unknown>> = [];

  const tenant = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      tenants.has(where.id) ? { id: where.id, tenantType: tenants.get(where.id) } : null,
    // `platformCurrencyOf`: the currency a reseller with no wallet yet reads zero in.
    findFirst: async () => ({ operatingCurrencyCode: 'EUR' }),
  };

  const all = {
    tenant,
    tenantBillingWallet: {
      findUnique: async ({ where }: { where: { tenantId: string } }) => {
        queries.push({ what: 'wallet', where });
        // Deliberately not the last row's balanceAfter: the header is the wallet's.
        return hasWallet ? { id: WALLET, cachedBalance: d('75.5'), currencyCode: 'USD' } : null;
      },
    },
    tenantBillingTransaction: {
      findMany: async (args: { where: unknown; orderBy: unknown; skip: number; take: number }) => {
        queries.push({ what: 'rows', ...args });
        return rows.slice(args.skip, args.skip + args.take);
      },
      count: async ({ where }: { where: unknown }) => {
        queries.push({ what: 'count', where });
        return rows.length;
      },
    },
  };

  const touched = { app: 0, all: 0 };
  const count = <T extends object>(pool: 'app' | 'all', client: T): T =>
    new Proxy(client, {
      get(target, prop, receiver) {
        touched[pool] += 1;
        return Reflect.get(target, prop, receiver);
      },
    });

  return { app: count('app', { tenant }), all: count('all', all), touched, queries };
}

function service(s: ReturnType<typeof store>) {
  // The fakes stand in for the two Prisma pools; only the members used are present.
  return new TenantBillingAdminService(s.app as never, s.all as never, null as never);
}

const owner = { adminId: ADMIN, tenantId: OWNER };
const reseller = { adminId: ADMIN, tenantId: RESELLER };

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TenantBillingAdminRefused) return e.reason;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('TenantBillingAdminService.history', () => {
  it('refuses a caller that is not the platform owner, without touching the cross-tenant pool', async () => {
    const s = store();
    expect(await refusal(service(s).history(reseller, RESELLER, {}))).toBe('not_platform_owner');
    expect(s.touched.all).toBe(0);
  });

  it("answers the wallet's own balance and its movements, newest first, for one reseller", async () => {
    const s = store();
    const page = await service(s).history(owner, RESELLER, { page: 1, pageSize: 20 });

    expect(page).toEqual({
      tenantId: RESELLER,
      balance: '75.50',
      currencyCode: 'USD',
      total: 2,
      page: 1,
      pageSize: 20,
      rows: [
        {
          id: 'b',
          direction: TenantLedgerDirection.debit,
          reasonType: TenantBillingReasonType.subscription_charge,
          referenceId: 'ref-b',
          amount: '40.00',
          balanceAfter: '60.00',
          currencyCode: 'USD',
          createdAt: new Date('2026-09-18T10:00:00Z'),
        },
        {
          id: 'a',
          direction: TenantLedgerDirection.credit,
          reasonType: TenantBillingReasonType.admin_manual_adjust,
          referenceId: 'ref-a',
          amount: '100.00',
          balanceAfter: '100.00',
          currencyCode: 'EUR',
          createdAt: new Date('2026-09-17T10:00:00Z'),
        },
      ],
    });

    // The rows are reached through the wallet's id, and a tie in `createdAt` is broken by `id`.
    const list = s.queries.find((q) => q.what === 'rows');
    expect(list).toMatchObject({
      where: { walletId: WALLET },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('pages the ledger: the second page skips the first', async () => {
    const s = store();
    const page = await service(s).history(owner, RESELLER, { page: 2, pageSize: 1 });

    expect(page.rows.map((r) => r.id)).toEqual(['a']);
    expect(page).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(s.queries.find((q) => q.what === 'rows')).toMatchObject({ skip: 1, take: 1 });
  });

  it('answers a zero balance and no rows for a reseller that has never been credited', async () => {
    const s = store({ hasWallet: false });
    expect(await service(s).history(owner, RESELLER, {})).toEqual({
      tenantId: RESELLER,
      balance: '0.00',
      currencyCode: 'EUR',
      total: 0,
      page: 1,
      pageSize: 20,
      rows: [],
    });
    expect(s.queries.some((q) => q.what === 'rows')).toBe(false);
  });

  it('refuses an unknown tenant, and the platform owner as its own target', async () => {
    const s = store();
    expect(await refusal(service(s).history(owner, MISSING, {}))).toBe('tenant_not_found');
    expect(await refusal(service(s).history(owner, OWNER, {}))).toBe('not_a_reseller');
  });
});
