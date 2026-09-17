import { Prisma } from '@prisma/client';
import { OutboxEventType, TenantBillingInsufficientBalance } from '@txnet-backend/shared-core';
import { TenantRenewalService, addBillingPeriod, periodChargeReference } from './tenant-renewal.service';

/**
 * The invariants F-019-c turns on (tenant invariant 19, `rules.md` #10-#13).
 *
 * - A due subscription whose wallet covers the package's price for the period
 *   is charged once (`subscription_charge`, a reference fixed by the period it
 *   pays for), moves `currentPeriodEnd` one period on, re-copies the package's
 *   keys into `package_included`, and takes `trial` or a **non-payment**
 *   suspension to `active`. A manual suspension is charged and stays.
 * - Paid within grace, the period runs on from the old end; paid after a
 *   non-payment suspension, from the moment of payment.
 * - A short wallet is warned at most once a day until `currentPeriodEnd` +
 *   `renewalGraceDays`, then suspended as `non_payment` — each notice an
 *   outbox row in the same transaction. Nothing is deleted.
 * - Lock order: the package, then the tenant row. Not due, terminated or
 *   already suspended and short writes nothing.
 */
describe('TenantRenewalService', () => {
  const TENANT = '44444444-4444-4444-4444-444444444444';
  const OWNER = '66666666-6666-6666-6666-666666666666';
  const PKG = '33333333-3333-3333-3333-333333333333';
  const DAY = 86_400_000;
  const NOW = new Date('2026-10-05T10:00:00.000Z');
  const END = new Date('2026-10-03T00:00:00.000Z');

  type Opts = {
    status?: string;
    cause?: string | null;
    balance?: string | null;
    periodEnd?: Date;
    warnedAt?: Date | null;
    graceUntil?: Date | null;
    billingModel?: string;
    graceDays?: number;
  };

  const build = (opts: Opts = {}) => {
    const writes: string[] = [];
    const periodEnd = opts.periodEnd ?? END;
    const sub = {
      tenantId: TENANT,
      packageId: PKG,
      currentPeriodEnd: periodEnd,
      renewalWarnedAt: opts.warnedAt ?? null,
      graceUntil: opts.graceUntil ?? null,
      package: { monthlyPrice: new Prisma.Decimal('1500000'), yearlyPrice: null, includedFeatureKeys: ['spin_wheel'] },
    };
    const tenantRow = {
      id: TENANT,
      tenantType: 'reseller',
      status: opts.status ?? 'active',
      suspensionCause: opts.cause ?? null,
      suspendedAt: null,
      graceEndsAt: null,
      billingModel: opts.billingModel ?? 'subscription_monthly',
      ownerUserId: OWNER,
    };
    const locks = [[{ id: PKG }], [tenantRow]];
    const tx = {
      $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
        writes.push(strings.join('?').includes('tenant_feature_package') ? 'lock.package' : 'lock.tenant');
        return locks.shift() ?? [];
      }),
      tenantSubscription: {
        findUnique: vi.fn(async () => sub),
        update: vi.fn(async (_args: { where: unknown; data: Record<string, unknown> }) => (writes.push('subscription'), sub)),
      },
      tenantBillingWallet: {
        findUnique: vi.fn(async () => (opts.balance === null ? null : { cachedBalance: new Prisma.Decimal(opts.balance ?? '2000000') })),
      },
      tenantFeatureEntitlement: {
        deleteMany: vi.fn(async () => (writes.push('entitlements.delete'), { count: 1 })),
        createMany: vi.fn(async () => (writes.push('entitlements.create'), { count: 1 })),
      },
      tenant: { update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push('tenant'), { ...tenantRow, ...data })) },
      tenantStatusHistory: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => (writes.push('history'), {})) },
      outboxEvent: { create: vi.fn(async (_args: { data: { type: string; aggregateId: string; payload: Record<string, unknown> } }) => (writes.push('outbox'), {})) },
    };
    const all = {
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      tenantSubscription: { findUnique: vi.fn(async () => ({ currentPeriodEnd: periodEnd })), findMany: vi.fn(async () => [{ tenantId: TENANT }]) },
      tenantSubscriptionSetting: { findUnique: vi.fn(async () => ({ renewalGraceDays: opts.graceDays ?? 3, suspensionHoldDays: 7 })) },
    };
    const ledger = {
      debit: vi.fn(async (_tx: unknown, entry: { amount: Prisma.Decimal }) => {
        if (new Prisma.Decimal(opts.balance ?? '2000000').lt(entry.amount)) throw new TenantBillingInsufficientBalance(TENANT);
        writes.push('debit');
        return {};
      }),
    };
    const service = new TenantRenewalService(all as never, ledger as never);
    return { service, tx, all, ledger, writes };
  };

  it('charges a due subscription once, moves the period on from its old end, re-copies the package and takes trial to active', async () => {
    const { service, tx, ledger, writes } = build({ status: 'trial' });
    await expect(service.renew(TENANT, NOW)).resolves.toBe('renewed');

    expect(writes.slice(0, 2)).toEqual(['lock.package', 'lock.tenant']);
    expect(ledger.debit).toHaveBeenCalledTimes(1);
    const entry = ledger.debit.mock.calls[0][1] as { tenantId: string; amount: Prisma.Decimal; reasonType: string; referenceId: string };
    expect(entry).toMatchObject({ tenantId: TENANT, reasonType: 'subscription_charge', referenceId: periodChargeReference(TENANT, END) });
    expect(entry.amount.toString()).toBe('1500000');
    expect(tx.tenantSubscription.update).toHaveBeenCalledWith({
      where: { tenantId: TENANT },
      data: { currentPeriodEnd: new Date('2026-11-03T00:00:00.000Z'), renewalWarnedAt: null, graceUntil: null },
    });
    expect(tx.tenantFeatureEntitlement.deleteMany).toHaveBeenCalledWith({ where: { tenantId: { in: [TENANT] }, source: 'package_included' } });
    expect(tx.tenant.update.mock.calls[0][0].data).toMatchObject({ status: 'active', suspensionCause: null, suspendedAt: null, graceEndsAt: null });
    expect(tx.tenantStatusHistory.create).toHaveBeenCalledWith({
      data: { tenantId: TENANT, fromStatus: 'trial', toStatus: 'active', reason: 'subscription_renewed', actorUserId: null },
    });
  });

  it('an active subscriber renewed stays active with no status write', async () => {
    const { service, tx, writes } = build();
    await expect(service.renew(TENANT, NOW)).resolves.toBe('renewed');
    expect(tx.tenant.update).not.toHaveBeenCalled();
    expect(writes).toContain('debit');
  });

  it('after a non-payment suspension the payment starts the period now and reactivates', async () => {
    const { service, tx } = build({ status: 'suspended', cause: 'non_payment', periodEnd: new Date('2026-09-01T00:00:00.000Z') });
    await expect(service.renew(TENANT, NOW)).resolves.toBe('renewed');
    expect(tx.tenantSubscription.update.mock.calls[0][0].data.currentPeriodEnd).toEqual(new Date('2026-11-05T10:00:00.000Z'));
    expect(tx.tenant.update.mock.calls[0][0].data).toMatchObject({ status: 'active', suspensionCause: null });
  });

  it('a manual suspension is charged and renewed but not lifted', async () => {
    const { service, tx, ledger } = build({ status: 'suspended', cause: 'manual' });
    await expect(service.renew(TENANT, NOW)).resolves.toBe('renewed');
    expect(ledger.debit).toHaveBeenCalledTimes(1);
    expect(tx.tenant.update).not.toHaveBeenCalled();
    expect(tx.tenantStatusHistory.create).not.toHaveBeenCalled();
  });

  it('short within grace: one warning as an outbox row, then none again for a day', async () => {
    const first = build({ balance: '100' });
    await expect(first.service.renew(TENANT, NOW)).resolves.toBe('warned');
    expect(first.ledger.debit).not.toHaveBeenCalled();
    expect(first.tx.tenantSubscription.update).toHaveBeenCalledWith({ where: { tenantId: TENANT }, data: { renewalWarnedAt: NOW } });
    const event = first.tx.outboxEvent.create.mock.calls[0][0].data as { type: string; aggregateId: string; payload: Record<string, unknown> };
    expect(event.type).toBe(OutboxEventType.TENANT_SUBSCRIPTION_PAYMENT_DUE);
    expect(event.payload).toMatchObject({ tenantId: TENANT, ownerUserId: OWNER, amount: '1500000.00', suspendsAt: new Date(END.getTime() + 3 * DAY).toISOString() });
    expect(first.tx.tenant.update).not.toHaveBeenCalled();

    const again = build({ balance: '100', warnedAt: new Date(NOW.getTime() - DAY / 2) });
    await expect(again.service.renew(TENANT, NOW)).resolves.toBe('waiting');
    expect(again.writes.filter((w) => !w.startsWith('lock'))).toEqual([]);
  });

  it('short past grace: suspended as non_payment with the hold stamped, and the owner told — nothing deleted', async () => {
    const { service, tx, writes } = build({ balance: null, periodEnd: new Date(NOW.getTime() - 3 * DAY) });
    await expect(service.renew(TENANT, NOW)).resolves.toBe('suspended');
    expect(tx.tenant.update.mock.calls[0][0].data).toEqual({
      status: 'suspended',
      suspensionCause: 'non_payment',
      suspendedAt: NOW,
      graceEndsAt: new Date(NOW.getTime() + 7 * DAY),
      suspendedReason: 'subscription_unpaid',
    });
    expect(tx.tenantStatusHistory.create.mock.calls[0][0].data).toMatchObject({ toStatus: 'suspended', actorUserId: null });
    expect(tx.outboxEvent.create.mock.calls[0][0].data.type).toBe(OutboxEventType.TENANT_SUBSCRIPTION_SUSPENDED);
    expect(tx.tenantFeatureEntitlement.deleteMany).not.toHaveBeenCalled();
    expect(writes.some((w) => w.includes('delete'))).toBe(false);
  });

  it('past the setting\'s grace but inside the platform owner\'s graceUntil: warned with that date, not suspended (F-019-g)', async () => {
    const graceUntil = new Date(NOW.getTime() + 4 * DAY);
    const { service, tx } = build({ balance: '0', periodEnd: new Date(NOW.getTime() - 5 * DAY), graceUntil });
    await expect(service.renew(TENANT, NOW)).resolves.toBe('warned');
    expect(tx.tenant.update).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create.mock.calls[0][0].data.payload).toMatchObject({ suspendsAt: graceUntil.toISOString() });

    const over = build({ balance: '0', periodEnd: new Date(NOW.getTime() - 5 * DAY), graceUntil: new Date(NOW.getTime() - 1) });
    await expect(over.service.renew(TENANT, NOW)).resolves.toBe('suspended');
  });

  it('already suspended and still short: nothing is written', async () => {
    const { service, writes } = build({ status: 'suspended', cause: 'non_payment', balance: '0', periodEnd: new Date('2026-09-01T00:00:00.000Z') });
    await expect(service.renew(TENANT, NOW)).resolves.toBe('waiting');
    expect(writes.filter((w) => !w.startsWith('lock'))).toEqual([]);
  });

  it('not due is answered before any transaction; terminated is skipped under the lock', async () => {
    const early = build({ periodEnd: new Date(NOW.getTime() + DAY) });
    await expect(early.service.renew(TENANT, NOW)).resolves.toBe('not_due');
    expect(early.all.$transaction).not.toHaveBeenCalled();

    const gone = build({ status: 'terminated' });
    await expect(gone.service.renew(TENANT, NOW)).resolves.toBe('skipped');
    expect(gone.ledger.debit).not.toHaveBeenCalled();
  });

  it('renewDue counts each outcome and a failing tenant does not stop the sweep', async () => {
    const { service, all } = build();
    all.tenantSubscription.findMany.mockResolvedValueOnce([{ tenantId: TENANT }, { tenantId: 'broken' }]);
    const renew = vi.spyOn(service, 'renew');
    renew.mockResolvedValueOnce('renewed').mockRejectedValueOnce(new Error('boom'));
    await expect(service.renewDue(NOW)).resolves.toMatchObject({ due: 2, renewed: 1, failed: 1 });
  });

  it('a period is a calendar month or year, clamped to the month end; the charge reference is fixed by the period', () => {
    expect(addBillingPeriod(new Date('2026-01-31T00:00:00.000Z'), 'subscription_monthly')).toEqual(new Date('2026-02-28T00:00:00.000Z'));
    expect(addBillingPeriod(new Date('2028-02-29T00:00:00.000Z'), 'subscription_yearly')).toEqual(new Date('2029-02-28T00:00:00.000Z'));
    expect(periodChargeReference(TENANT, END)).toBe(periodChargeReference(TENANT, new Date(END)));
    expect(periodChargeReference(TENANT, END)).not.toBe(periodChargeReference(TENANT, NOW));
    expect(periodChargeReference(TENANT, END)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
