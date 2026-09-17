/**
 * A reseller's billing wallet, adjusted by the platform owner (F-019-a, D-41).
 *
 * Every way this breaks is silent, which is what earns it the row's one spec:
 *
 *  - **the version guard.** Of two debits that read the same balance exactly
 *    one lands; without it both subtract from the same start and the ledger
 *    still looks consistent row by row;
 *  - **prepaid only (D-01).** A debit below zero is refused and appends nothing;
 *  - **one entry per (reason, reference).** The same request applied twice is
 *    refused, so a double-click or a retried call cannot credit twice;
 *  - **the pool follows the caller (ADR-0053).** Only the platform owner may
 *    adjust, and a refused non-owner never touches the cross-tenant pool.
 *
 * What the database holds for every writer — a balance that cannot go
 * negative, the unique (reason, reference) — is the migration's CHECK and
 * index; the fake below is a store, not a list of expected calls, and applies
 * `updateMany`'s `where` the way Postgres re-checks it after a row lock.
 */
import { Prisma, TenantBillingReasonType, TenantType } from '@prisma/client';
import { TenantBillingLedger } from '@txnet-backend/shared-core';

import { TenantBillingAdminRefused, TenantBillingAdminService } from './tenant-billing-admin.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const MISSING = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const REQ_1 = 'e0000000-0000-4000-8000-000000000001';
const REQ_2 = 'e0000000-0000-4000-8000-000000000002';

const D = (v: string | number) => new Prisma.Decimal(v);

type Wallet = { id: string; tenantId: string; cachedBalance: Prisma.Decimal; version: number };
type Entry = Record<string, unknown> & { reasonType: TenantBillingReasonType; referenceId: string | null };

function store() {
  const tenants = new Map<string, TenantType>([
    [OWNER, TenantType.platform_owner],
    [RESELLER, TenantType.reseller],
  ]);
  const wallets = new Map<string, Wallet>();
  const ledger: Entry[] = [];
  const audit: Array<Record<string, unknown>> = [];
  const outbox: Array<{ type: string; payload: Record<string, unknown> }> = [];
  /** Resolved once `waiting` wallet reads have happened — forces two debits to read the same version. */
  let barrier: { waiting: number; release: () => void; ready: Promise<void> } | null = null;

  const tenant = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      tenants.has(where.id) ? { id: where.id, tenantType: tenants.get(where.id) } : null,
  };

  const tx = {
    tenant,
    tenantBillingWallet: {
      findUnique: async ({ where }: { where: { tenantId: string } }) => {
        const row = wallets.get(where.tenantId);
        const snapshot = row ? { ...row } : null;
        if (barrier) {
          barrier.waiting -= 1;
          if (barrier.waiting === 0) barrier.release();
          await barrier.ready;
        }
        return snapshot;
      },
      findUniqueOrThrow: async ({ where }: { where: { tenantId: string } }) => {
        const row = wallets.get(where.tenantId);
        if (!row) throw new Error('no wallet');
        return { ...row };
      },
      createMany: async ({ data }: { data: Array<{ tenantId: string }> }) => {
        for (const { tenantId } of data) {
          if (!wallets.has(tenantId)) {
            wallets.set(tenantId, { id: `wallet-${tenantId}`, tenantId, cachedBalance: D(0), version: 0 });
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
    tenantBillingTransaction: {
      findFirst: async ({ where }: { where: { reasonType: TenantBillingReasonType; referenceId: string } }) =>
        ledger.find((e) => e.reasonType === where.reasonType && e.referenceId === where.referenceId) ?? null,
      create: async ({ data }: { data: Entry }) => {
        const row = { id: `tx-${ledger.length + 1}`, createdAt: new Date(), ...data };
        ledger.push(row);
        return row;
      },
    },
    adminAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audit.push(data);
        return data;
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: { type: string; payload: Record<string, unknown> } }) => (outbox.push(data), { id: `evt-${outbox.length}` }),
    },
  };

  /**
   * A pass-through transaction, deliberately without rollback: every refusal
   * must happen before the first write, so "appends nothing" is the ledger's
   * ordering being tested, not the fake undoing it.
   */
  const $transaction = async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => fn(tx);

  const touched = { app: 0, all: 0 };
  const count = <T extends object>(pool: 'app' | 'all', client: T): T =>
    new Proxy(client, {
      get(target, prop, receiver) {
        touched[pool] += 1;
        return Reflect.get(target, prop, receiver);
      },
    });

  return {
    app: count('app', { tenant, $transaction }),
    all: count('all', { tenant, $transaction }),
    touched,
    balance: (tenantId: string) => wallets.get(tenantId)?.cachedBalance.toString(),
    ledger: () => ledger,
    audit: () => audit,
    outbox: () => outbox,
    interleave(readers: number) {
      let release!: () => void;
      const ready = new Promise<void>((r) => (release = r));
      barrier = { waiting: readers, release, ready };
    },
  };
}

function service(s: ReturnType<typeof store>) {
  // The fakes stand in for the two Prisma pools; only the members used are present.
  return new TenantBillingAdminService(s.app as never, s.all as never, new TenantBillingLedger());
}

const owner = { adminId: ADMIN, tenantId: OWNER, ip: '127.0.0.1' };
const reseller = { adminId: ADMIN, tenantId: RESELLER, ip: '127.0.0.1' };

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TenantBillingAdminRefused) return e.reason;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('TenantBillingAdminService.adjust', () => {
  it('refuses a caller that is not the platform owner, without touching the cross-tenant pool', async () => {
    const s = store();
    const reason = await refusal(
      service(s).adjust(reseller, RESELLER, { direction: 'credit', amount: '100', requestId: REQ_1 }),
    );
    expect(reason).toBe('not_platform_owner');
    expect(s.touched.all).toBe(0);
    expect(s.balance(RESELLER)).toBeUndefined();
  });

  it('credits a reseller by hand: one ledger entry, the cache beside it, one audit row', async () => {
    const s = store();
    const view = await service(s).adjust(owner, RESELLER, {
      direction: 'credit',
      amount: '250.50',
      requestId: REQ_1,
      note: 'bank transfer 1405-06',
    });

    expect(view.balanceAfter).toBe('250.5');
    expect(s.balance(RESELLER)).toBe('250.5');
    expect(s.ledger()).toHaveLength(1);
    expect(s.ledger()[0]).toMatchObject({
      reasonType: TenantBillingReasonType.admin_manual_adjust,
      referenceId: REQ_1,
      direction: 'credit',
    });
    expect(s.audit()).toHaveLength(1);
    expect(s.audit()[0]).toMatchObject({ tenantId: RESELLER, adminId: ADMIN, action: 'tenant_billing_adjust' });
    // Every credit announces itself in its own transaction, so an unpaid renewal is charged at once (F-019-c).
    expect(s.outbox()).toEqual([
      expect.objectContaining({ type: 'tenant.billing.credited', payload: { tenantId: RESELLER, transactionId: 'tx-1', balanceAfter: '250.50' } }),
    ]);
  });

  it('refuses a debit below zero and appends nothing (prepaid only, D-01)', async () => {
    const s = store();
    const svc = service(s);
    await svc.adjust(owner, RESELLER, { direction: 'credit', amount: '10', requestId: REQ_1 });

    const reason = await refusal(svc.adjust(owner, RESELLER, { direction: 'debit', amount: '10.01', requestId: REQ_2 }));

    expect(reason).toBe('insufficient_balance');
    expect(s.balance(RESELLER)).toBe('10');
    expect(s.ledger()).toHaveLength(1);
    expect(s.audit()).toHaveLength(1);
  });

  it('refuses a debit from a reseller that has no wallet yet', async () => {
    const s = store();
    expect(await refusal(service(s).adjust(owner, RESELLER, { direction: 'debit', amount: '1', requestId: REQ_1 }))).toBe(
      'insufficient_balance',
    );
  });

  it('applies one request once: the same requestId again is refused and credits nothing', async () => {
    const s = store();
    const svc = service(s);
    await svc.adjust(owner, RESELLER, { direction: 'credit', amount: '40', requestId: REQ_1 });

    const reason = await refusal(svc.adjust(owner, RESELLER, { direction: 'credit', amount: '40', requestId: REQ_1 }));

    expect(reason).toBe('duplicate_request');
    expect(s.balance(RESELLER)).toBe('40');
    expect(s.ledger()).toHaveLength(1);
  });

  it('lets exactly one of two debits that read the same version land', async () => {
    const s = store();
    const svc = service(s);
    await svc.adjust(owner, RESELLER, { direction: 'credit', amount: '100', requestId: REQ_1 });

    s.interleave(2);
    const results = await Promise.allSettled([
      svc.adjust(owner, RESELLER, { direction: 'debit', amount: '80', requestId: 'e0000000-0000-4000-8000-00000000000a' }),
      svc.adjust(owner, RESELLER, { direction: 'debit', amount: '80', requestId: 'e0000000-0000-4000-8000-00000000000b' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(lost?.reason).toBeInstanceOf(TenantBillingAdminRefused);
    expect((lost?.reason as TenantBillingAdminRefused).reason).toBe('wallet_changed');
    expect(s.balance(RESELLER)).toBe('20');
    expect(s.ledger()).toHaveLength(2);
  });

  it('refuses an amount that is zero or finer than the column, never rounding it', async () => {
    const s = store();
    const svc = service(s);
    expect(await refusal(svc.adjust(owner, RESELLER, { direction: 'credit', amount: '0', requestId: REQ_1 }))).toBe('invalid_amount');
    expect(await refusal(svc.adjust(owner, RESELLER, { direction: 'credit', amount: '1.005', requestId: REQ_1 }))).toBe(
      'invalid_amount',
    );
    expect(s.ledger()).toHaveLength(0);
  });

  it('refuses an unknown tenant, and the platform owner as its own target', async () => {
    const s = store();
    const svc = service(s);
    expect(await refusal(svc.adjust(owner, MISSING, { direction: 'credit', amount: '1', requestId: REQ_1 }))).toBe(
      'tenant_not_found',
    );
    expect(await refusal(svc.adjust(owner, OWNER, { direction: 'credit', amount: '1', requestId: REQ_1 }))).toBe(
      'not_a_reseller',
    );
  });
});
