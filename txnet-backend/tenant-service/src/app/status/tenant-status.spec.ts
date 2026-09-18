import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  TENANT_CAPABILITIES,
  TenantCapability,
  TenantStatusGuard,
  TenantStatusPolicy,
  UnscopedRedisKeys,
  capabilityOf,
  runWithTenant,
  serializeTenantStatusState,
  tenantAllows,
} from '@txnet-backend/shared-core';
import { TenantStatusService } from './tenant-status.service';
import { TenantStatusListener } from './tenant-status.listener';
import { changeTenantStatusSchema } from './tenant-status.schema';

/**
 * The invariants F-018-f turns on (D-42 (1), `tenant/rules.md`).
 *
 * - One matrix decides: `suspended` keeps sign-in, reads, the user's own
 *   account and the reseller's billing top-up, and closes staff writes,
 *   registration, sales and end-user deposits; `/sub` is served until
 *   `graceEndsAt` and refused after. `terminated` closes everything but the
 *   platform's own settlement of what already happened.
 * - The guard fails closed: a mutating route that declares no capability is a
 *   staff write. A missing Redis key refuses nobody (F-101-b's pattern).
 * - Suspending stamps `suspendedAt` and `graceEndsAt` = now + the hold setting,
 *   and every change appends one history row and one audit row, in one
 *   transaction under the tenant row's lock. `terminated` is final; the
 *   platform owner cannot be suspended.
 * - The listener writes what the guard reads.
 */
describe('TenantStatusPolicy', () => {
  const now = new Date('2026-09-17T12:00:00Z');
  const later = new Date('2026-09-20T12:00:00Z');
  const suspended = { status: 'suspended' as const, graceEndsAt: later.toISOString() };

  it('leaves trial and active tenants every capability', () => {
    for (const status of ['trial', 'active'] as const) {
      for (const c of TENANT_CAPABILITIES) expect(tenantAllows({ status, graceEndsAt: null }, c, now)).toBe(true);
    }
  });

  it('suspended: panel read-only, billing open, end users sign in and buy nothing', () => {
    const open = TENANT_CAPABILITIES.filter((c) => tenantAllows(suspended, c, now));
    expect(open.sort()).toEqual(['account', 'read', 'signIn', 'signOut', 'subscriptionLink', 'system', 'tenantBilling']);
  });

  it('suspended: /sub is served until graceEndsAt, then refused', () => {
    expect(tenantAllows(suspended, 'subscriptionLink', now)).toBe(true);
    expect(tenantAllows(suspended, 'subscriptionLink', new Date(later.getTime() + 1))).toBe(false);
    expect(tenantAllows({ status: 'suspended', graceEndsAt: null }, 'subscriptionLink', now)).toBe(false);
  });

  it('terminated: everything closed but signing out and settling what already happened', () => {
    const open = TENANT_CAPABILITIES.filter((c) => tenantAllows({ status: 'terminated', graceEndsAt: later.toISOString() }, c, now));
    expect(open.sort()).toEqual(['signOut', 'system']);
    expect(Object.keys(TenantStatusPolicy).sort()).toEqual(['active', 'suspended', 'terminated', 'trial']);
  });

  it('a route with no declared capability: GET reads, anything else is a staff write', () => {
    expect(capabilityOf('GET', undefined)).toBe('read');
    expect(capabilityOf('HEAD', undefined)).toBe('read');
    expect(capabilityOf('POST', undefined)).toBe('staffWrite');
    expect(capabilityOf('DELETE', undefined)).toBe('staffWrite');
    expect(capabilityOf('POST', 'register')).toBe('register');
  });
});

describe('TenantStatusGuard', () => {
  const TENANT = '44444444-4444-4444-4444-444444444444';

  class Routes {
    @TenantCapability('register')
    register(): void {}
    edit(): void {}
    list(): void {}
  }

  const run = async (state: string | null, method: string, handler: keyof Routes, tenant: string | null = TENANT) => {
    const redis = { get: vi.fn(async () => state) };
    const guard = new TenantStatusGuard(new Reflector(), redis);
    const context = {
      getHandler: () => Routes.prototype[handler],
      getClass: () => Routes,
      switchToHttp: () => ({ getRequest: () => ({ method }) }),
    };
    const result = await runWithTenant(tenant ? { id: tenant } : null, () => guard.canActivate(context as never));
    return { result, redis };
  };

  const suspended = serializeTenantStatusState({ status: 'suspended', graceEndsAt: new Date(Date.now() + 86_400_000).toISOString() });

  it('refuses an undeclared write for a suspended tenant with tenant.suspended', async () => {
    await expect(run(suspended, 'POST', 'edit')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run(suspended, 'POST', 'edit')).rejects.toMatchObject({
      response: { i18nKey: 'tenant.suspended', reason: 'tenantSuspended' },
    });
  });

  it('reads the key the listener writes, and lets a suspended tenant read', async () => {
    const { result, redis } = await run(suspended, 'GET', 'list');
    expect(result).toBe(true);
    expect(redis.get).toHaveBeenCalledWith(UnscopedRedisKeys.tenantStatus(TENANT));
  });

  it('refuses a declared capability the status closes, and a terminated tenant a read', async () => {
    await expect(run(suspended, 'POST', 'register')).rejects.toMatchObject({ response: { reason: 'tenantSuspended' } });
    const terminated = serializeTenantStatusState({ status: 'terminated', graceEndsAt: null });
    await expect(run(terminated, 'GET', 'list')).rejects.toMatchObject({ response: { i18nKey: 'tenant.terminated', reason: 'tenantTerminated' } });
  });

  it('a missing key, an unreadable one, or no tenant refuses nobody', async () => {
    expect((await run(null, 'POST', 'edit')).result).toBe(true);
    expect((await run('not json', 'POST', 'edit')).result).toBe(true);
    const { result, redis } = await run(suspended, 'POST', 'edit', null);
    expect(result).toBe(true);
    expect(redis.get).not.toHaveBeenCalled();
  });
});

describe('TenantStatusService', () => {
  const OWNER_TENANT = '11111111-1111-1111-1111-111111111111';
  const ADMIN = '22222222-2222-2222-2222-222222222222';
  const RESELLER = '44444444-4444-4444-4444-444444444444';
  const DAY = 86_400_000;
  const actor = { adminId: ADMIN, tenantId: OWNER_TENANT, ip: '127.0.0.1' };

  const build = (opts: { callerType?: string; status?: string; cause?: string | null; tenantType?: string; holdDays?: number; found?: boolean } = {}) => {
    const writes: string[] = [];
    const row = { id: RESELLER, tenantType: opts.tenantType ?? 'reseller', status: opts.status ?? 'active', suspensionCause: opts.cause ?? null, suspendedAt: null, graceEndsAt: null, suspendedReason: null };
    const tx = {
      $queryRaw: vi.fn(async () => (writes.push('lock'), opts.found === false ? [] : [row])),
      tenant: { update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (writes.push('tenant'), { ...row, ...data })) },
      tenantStatusHistory: { create: vi.fn(async (_: { data: Record<string, unknown> }) => (writes.push('history'), {})) },
      adminAuditLog: { create: vi.fn(async (_: { data: Record<string, unknown> }) => (writes.push('audit'), {})) },
    };
    const prisma = { tenant: { findUnique: vi.fn(async () => ({ tenantType: opts.callerType ?? 'platform_owner' })) } };
    const all = {
      tenantSubscriptionSetting: { findUnique: vi.fn(async () => ({ suspensionHoldDays: opts.holdDays ?? 7 })) },
      tenantStatusHistory: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    return { service: new TenantStatusService(prisma as never, all as never), all, tx, writes };
  };

  it('accepts only active, suspended or terminated, and no dates from the caller', () => {
    expect(changeTenantStatusSchema.safeParse({ status: 'suspended', reason: 'unpaid' }).success).toBe(true);
    expect(changeTenantStatusSchema.safeParse({ status: 'trial' }).success).toBe(false);
    expect(changeTenantStatusSchema.safeParse({ status: 'suspended', graceEndsAt: '2030-01-01' }).success).toBe(false);
  });

  it('refuses a caller who is not the platform owner before the cross-tenant pool is touched', async () => {
    const { service, all } = build({ callerType: 'reseller' });
    await expect(service.change(actor, RESELLER, { status: 'suspended' })).rejects.toMatchObject({ reason: 'not_platform_owner' });
    expect(all.$transaction).not.toHaveBeenCalled();
  });

  it('suspends: suspendedAt now, graceEndsAt now + the hold setting, history and audit in the lock', async () => {
    const { service, tx, writes } = build({ holdDays: 3 });
    const before = Date.now();
    const view = await service.change(actor, RESELLER, { status: 'suspended', reason: 'unpaid' });

    expect(writes).toEqual(['lock', 'tenant', 'history', 'audit']);
    const data = tx.tenant.update.mock.calls[0][0].data as { status: string; suspendedAt: Date; graceEndsAt: Date; suspendedReason: string };
    expect(data.status).toBe('suspended');
    expect(data.suspendedReason).toBe('unpaid');
    expect(data.suspendedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(data.graceEndsAt.getTime() - data.suspendedAt.getTime()).toBe(3 * DAY);
    expect(tx.tenantStatusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: RESELLER, fromStatus: 'active', toStatus: 'suspended', reason: 'unpaid', actorUserId: ADMIN }),
    });
    expect(tx.adminAuditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'tenant_status_change', tenantId: RESELLER, targetEntityId: RESELLER });
    expect(view.status).toBe('suspended');
  });

  it('reactivating clears suspendedAt and graceEndsAt', async () => {
    const { service, tx } = build({ status: 'suspended' });
    await service.change(actor, RESELLER, { status: 'active' });
    expect(tx.tenant.update.mock.calls[0][0].data).toMatchObject({ status: 'active', suspendedAt: null, graceEndsAt: null, suspendedReason: null });
  });

  it('suspending a reseller suspended for non-payment makes the cause manual, keeping its stamps (F-018-s)', async () => {
    const { service, tx, writes } = build({ status: 'suspended', cause: 'non_payment' });
    const view = await service.change(actor, RESELLER, { status: 'suspended', reason: 'spam' });

    expect(writes).toEqual(['lock', 'tenant', 'history', 'audit']);
    expect(tx.tenant.update.mock.calls[0][0].data).toEqual({ suspensionCause: 'manual', suspendedReason: 'spam' });
    expect(tx.tenantStatusHistory.create.mock.calls[0][0].data).toMatchObject({ fromStatus: 'suspended', toStatus: 'suspended', reason: 'spam', actorUserId: ADMIN });
    expect(tx.adminAuditLog.create.mock.calls[0][0].data).toMatchObject({ oldValue: { suspensionCause: 'non_payment' }, newValue: { suspensionCause: 'manual' } });
    expect(view).toMatchObject({ status: 'suspended', suspensionCause: 'manual' });
  });

  it('terminated is final, an unchanged status is refused, and the platform owner is never a reseller', async () => {
    await expect(build({ status: 'terminated' }).service.change(actor, RESELLER, { status: 'active' })).rejects.toMatchObject({ reason: 'reseller_terminated' });
    const same = build({ status: 'suspended', cause: 'manual' });
    await expect(same.service.change(actor, RESELLER, { status: 'suspended' })).rejects.toMatchObject({ reason: 'status_unchanged' });
    expect(same.writes).toEqual(['lock']);
    await expect(build({ tenantType: 'platform_owner' }).service.change(actor, OWNER_TENANT, { status: 'suspended' })).rejects.toMatchObject({ reason: 'reseller_not_found' });
    await expect(build({ found: false }).service.change(actor, RESELLER, { status: 'suspended' })).rejects.toMatchObject({ reason: 'reseller_not_found' });
  });
});

describe('TenantStatusListener', () => {
  const RESELLER = '44444444-4444-4444-4444-444444444444';

  it('writes the state a notification names, in the shape the guard reads', async () => {
    const graceEndsAt = new Date('2026-09-24T12:00:00Z');
    const redis = { set: vi.fn(async () => undefined), publish: vi.fn(async () => undefined) };
    const all = { tenant: { findUnique: vi.fn(async () => ({ id: RESELLER, status: 'suspended', graceEndsAt })), findMany: vi.fn(async () => []) } };
    const listener = new TenantStatusListener(all as never, redis as never, (() => ({})) as never);

    await listener.handle(JSON.stringify({ tenantId: RESELLER }));
    expect(redis.set).toHaveBeenCalledWith(
      UnscopedRedisKeys.tenantStatus(RESELLER),
      serializeTenantStatusState({ status: 'suspended', graceEndsAt: graceEndsAt.toISOString() }),
    );

    // …and then tells the gateway which tenant changed, so a terminated one's sockets close at once (F-018-r).
    expect(redis.publish).toHaveBeenCalledWith(UnscopedRedisKeys.tenantStatusChanged(), RESELLER);
    expect(redis.set.mock.invocationCallOrder[0]).toBeLessThan(redis.publish.mock.invocationCallOrder[0]);

    await listener.handle('not json');
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.publish).toHaveBeenCalledTimes(1);
  });
});
