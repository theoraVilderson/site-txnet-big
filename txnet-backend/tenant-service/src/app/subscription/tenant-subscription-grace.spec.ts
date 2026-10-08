import { OutboxEventType } from '@txnet-backend/shared-core';
import { TenantSubscriptionService } from './tenant-subscription.service';
import { grantGraceSchema } from './tenant-subscription.schema';

/**
 * The invariants F-019-g turns on: the platform owner gives an unpaid reseller
 * more time without inventing a payment (`rules.md` #15, invariant 19).
 *
 * - `graceUntil` = the latest of now, the renewal's own deadline
 *   (`currentPeriodEnd` + `renewalGraceDays`) and an earlier `graceUntil`,
 *   plus `days` — a grant never shortens the time a reseller already had.
 * - A `non_payment` suspension is lifted at once (history row, the admin as
 *   actor); a `manual` suspension is not. Trial and active keep their status.
 * - One transaction under the tenant row's lock, one audit row
 *   `tenant_subscription_grace`, and **no** ledger entry and no period change.
 * - Only the platform owner; a terminated reseller or one with no subscription is refused.
 */
describe('TenantSubscriptionService.grantGrace', () => {
  const OWNER_TENANT = '11111111-1111-1111-1111-111111111111';
  const ADMIN = '22222222-2222-2222-2222-222222222222';
  const RESELLER = '44444444-4444-4444-4444-444444444444';
  const OWNER = '55555555-5555-4555-8555-555555555555';
  const DAY = 86_400_000;
  const NOW = new Date('2026-10-05T10:00:00.000Z');
  const actor = { adminId: ADMIN, tenantId: OWNER_TENANT, ip: '127.0.0.1' };

  type Opts = {
    callerType?: string;
    status?: string;
    cause?: string | null;
    periodEnd?: Date;
    graceUntil?: Date | null;
    subscription?: boolean;
    resellerFound?: boolean;
  };

  const build = (opts: Opts = {}) => {
    const writes: string[] = [];
    const tenantRow = {
      id: RESELLER,
      tenantType: 'reseller',
      status: opts.status ?? 'active',
      suspensionCause: opts.cause ?? null,
      ownerUserId: OWNER,
    };
    const sub = { currentPeriodEnd: opts.periodEnd ?? new Date('2026-10-03T00:00:00.000Z'), graceUntil: opts.graceUntil ?? null };
    const tx = {
      $queryRaw: vi.fn(async () => (writes.push('lock.tenant'), opts.resellerFound === false ? [] : [tenantRow])),
      tenantSubscription: {
        findUnique: vi.fn(async () => (opts.subscription === false ? null : sub)),
        update: vi.fn(async ({ data }: { where: unknown; data: { graceUntil: Date } }) => (writes.push('subscription'), { ...sub, ...data })),
      },
      tenant: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push('tenant'), { ...tenantRow, suspendedAt: null, graceEndsAt: null, suspendedReason: null, ...data })),
      },
      tenantStatusHistory: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => (writes.push('history'), {})) },
      outboxEvent: { create: vi.fn(async (_args: { data: { type: string; aggregateId: string; payload: Record<string, unknown> } }) => (writes.push('outbox'), {})) },
      tenantBillingTransaction: { create: vi.fn() },
      tenantBillingWallet: { update: vi.fn() },
      adminAuditLog: { create: vi.fn(async (_args: { data: Record<string, unknown> }) => (writes.push('audit'), {})) },
    };
    const prisma = { tenant: { findUnique: vi.fn(async () => ({ tenantType: opts.callerType ?? 'platform_owner' })) } };
    const all = {
      tenantSubscriptionSetting: { findUnique: vi.fn(async () => ({ renewalGraceDays: 3 })) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    return { service: new TenantSubscriptionService(prisma as never, all as never, {} as never, {} as never), all, tx, writes };
  };

  const input = { days: 7, reason: 'bank transfer delayed' };

  it('lifts a non_payment suspension at once and gives days from now, with history, audit and no ledger entry', async () => {
    const { service, tx, writes } = build({ status: 'suspended', cause: 'non_payment', periodEnd: new Date('2026-09-20T00:00:00.000Z') });
    const view = await service.grantGrace(actor, RESELLER, input, NOW);

    expect(writes[0]).toBe('lock.tenant');
    expect(view).toMatchObject({ tenantId: RESELLER, graceUntil: new Date(NOW.getTime() + 7 * DAY), status: 'active', suspensionCause: null });
    expect(tx.tenantSubscription.update).toHaveBeenCalledWith({
      where: { tenantId: RESELLER },
      data: { graceUntil: new Date(NOW.getTime() + 7 * DAY) },
      select: { currentPeriodEnd: true, graceUntil: true },
    });
    expect(tx.tenant.update.mock.calls[0][0].data).toMatchObject({ status: 'active', suspensionCause: null, suspendedAt: null, graceEndsAt: null });
    expect(tx.tenantStatusHistory.create.mock.calls[0][0].data).toEqual({
      tenantId: RESELLER,
      fromStatus: 'suspended',
      toStatus: 'active',
      reason: input.reason,
      actorUserId: ADMIN,
    });
    const audit = tx.adminAuditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ tenantId: RESELLER, adminId: ADMIN, action: 'tenant_subscription_grace', targetEntityType: 'tenant', targetEntityId: RESELLER });
    expect(tx.tenantBillingTransaction.create).not.toHaveBeenCalled();
    expect(tx.tenantBillingWallet.update).not.toHaveBeenCalled();
  });

  it('never shortens the time already given: counts from the renewal deadline or an earlier grace, whichever is later', async () => {
    // Due 2026-10-03, 3 days' grace -> the renewal would suspend on 2026-10-06; 7 more days is 2026-10-13.
    const inGrace = build();
    await expect(inGrace.service.grantGrace(actor, RESELLER, input, NOW)).resolves.toMatchObject({
      graceUntil: new Date('2026-10-13T00:00:00.000Z'),
      status: 'active',
    });
    expect(inGrace.tx.tenant.update).not.toHaveBeenCalled();
    // F-019-c3: no status moved, and the owner's open My services still hears the new deadline.
    expect(inGrace.tx.outboxEvent.create.mock.calls.map((c) => c[0].data)).toEqual([
      expect.objectContaining({ aggregateId: RESELLER, type: OutboxEventType.TENANT_SUBSCRIPTION_GRACE_EXTENDED, payload: { tenantId: RESELLER, userId: OWNER } }),
    ]);

    const extended = build({ graceUntil: new Date('2026-10-20T00:00:00.000Z') });
    await expect(extended.service.grantGrace(actor, RESELLER, input, NOW)).resolves.toMatchObject({ graceUntil: new Date('2026-10-27T00:00:00.000Z') });
  });

  it('a manual suspension gets the time but stays suspended', async () => {
    const { service, tx } = build({ status: 'suspended', cause: 'manual', periodEnd: new Date('2026-09-20T00:00:00.000Z') });
    await expect(service.grantGrace(actor, RESELLER, input, NOW)).resolves.toMatchObject({ status: 'suspended', suspensionCause: 'manual' });
    expect(tx.tenant.update).not.toHaveBeenCalled();
    expect(tx.tenantStatusHistory.create).not.toHaveBeenCalled();
    expect(tx.adminAuditLog.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-owner before the cross-tenant pool, and names a missing, terminated or unsubscribed reseller', async () => {
    const stranger = build({ callerType: 'reseller' });
    await expect(stranger.service.grantGrace(actor, RESELLER, input, NOW)).rejects.toMatchObject({ reason: 'not_platform_owner' });
    expect(stranger.all.$transaction).not.toHaveBeenCalled();

    await expect(build({ resellerFound: false }).service.grantGrace(actor, RESELLER, input, NOW)).rejects.toMatchObject({ reason: 'reseller_not_found' });
    const gone = build({ status: 'terminated' });
    await expect(gone.service.grantGrace(actor, RESELLER, input, NOW)).rejects.toMatchObject({ reason: 'reseller_terminated' });
    expect(gone.writes).toEqual(['lock.tenant']);
    await expect(build({ subscription: false }).service.grantGrace(actor, RESELLER, input, NOW)).rejects.toMatchObject({ reason: 'subscription_not_found' });
  });

  it('takes whole days 1..90 and a reason, and nothing else', () => {
    expect(grantGraceSchema.safeParse(input).success).toBe(true);
    expect(grantGraceSchema.safeParse({ days: 0, reason: 'x' }).success).toBe(false);
    expect(grantGraceSchema.safeParse({ days: 91, reason: 'x' }).success).toBe(false);
    expect(grantGraceSchema.safeParse({ days: 1.5, reason: 'x' }).success).toBe(false);
    expect(grantGraceSchema.safeParse({ days: 3 }).success).toBe(false);
    expect(grantGraceSchema.safeParse({ days: 3, reason: 'x', graceUntil: '2027-01-01' }).success).toBe(false);
  });
});

/**
 * F-019-c4: the platform's `renewalGraceDays` moves the deadline of every
 * reseller already in grace, and My services names that deadline. Only those
 * whose deadline actually moved are told: a reseller the platform owner gave
 * a later `graceUntil` keeps its date.
 */
describe('TenantSubscriptionService.updateSettings tells the resellers in grace', () => {
  const ADMIN = '22222222-2222-2222-2222-222222222222';
  const OWNER_TENANT = '11111111-1111-1111-1111-111111111111';
  const actor = { adminId: ADMIN, tenantId: OWNER_TENANT, ip: '127.0.0.1' };
  const DAY = 86_400_000;
  const ENDED = new Date(Date.now() - DAY);
  const settings = { trialDays: 7, suspensionHoldDays: 7, renewalGraceDays: 3, quotaTimeZone: 'Asia/Tehran' };

  const build = (inGrace: Array<{ tenantId: string; currentPeriodEnd: Date; graceUntil: Date | null; tenant: { ownerUserId: string } }>) => {
    const tx = {
      tenantSubscriptionSetting: {
        findUnique: vi.fn(async () => settings),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...settings, ...data })),
      },
      tenantSubscription: { findMany: vi.fn(async (_args: { where: unknown }) => inGrace) },
      outboxEvent: { createMany: vi.fn(async (_args: { data: Array<{ type: string; aggregateId: string; payload: Record<string, unknown> }> }) => ({ count: 0 })) },
      adminAuditLog: { create: vi.fn(async () => ({})) },
    };
    const prisma = { tenant: { findUnique: vi.fn(async () => ({ tenantType: 'platform_owner' })) } };
    const all = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    return { service: new TenantSubscriptionService(prisma as never, all as never, {} as never, {} as never), tx };
  };

  it('writes grace_extended for each reseller in grace whose deadline moved, and only those', async () => {
    const { service, tx } = build([
      { tenantId: 'r-moved', currentPeriodEnd: ENDED, graceUntil: null, tenant: { ownerUserId: 'u-1' } },
      { tenantId: 'r-held', currentPeriodEnd: ENDED, graceUntil: new Date(ENDED.getTime() + 30 * DAY), tenant: { ownerUserId: 'u-2' } },
    ]);
    await service.updateSettings(actor, { ...settings, renewalGraceDays: 5 });

    expect(tx.tenantSubscription.findMany.mock.calls[0][0].where).toMatchObject({
      tenant: { tenantType: 'reseller', deletedAt: null, status: { in: ['active', 'trial'] } },
    });
    expect(tx.outboxEvent.createMany.mock.calls[0][0].data).toEqual([
      { aggregate: 'tenant.subscription', aggregateId: 'r-moved', type: OutboxEventType.TENANT_SUBSCRIPTION_GRACE_EXTENDED, payload: { tenantId: 'r-moved', userId: 'u-1' } },
    ]);
  });

  it('reads and writes nothing more when the grace days did not change', async () => {
    const { service, tx } = build([{ tenantId: 'r-1', currentPeriodEnd: ENDED, graceUntil: null, tenant: { ownerUserId: 'u-1' } }]);
    await service.updateSettings(actor, { ...settings, trialDays: 10 });
    expect(tx.tenantSubscription.findMany).not.toHaveBeenCalled();
    expect(tx.outboxEvent.createMany).not.toHaveBeenCalled();
  });
});
