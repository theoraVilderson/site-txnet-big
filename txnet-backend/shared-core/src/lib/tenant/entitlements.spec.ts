import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { runWithTenant } from '../tenant-context/tenant-context';
import {
  RequiresFeature,
  TenantEntitlementGuard,
  TenantEntitlements,
  type TenantEntitlementRow,
} from './entitlements';

const TENANT = '55555555-5555-5555-5555-555555555555';
const NOW = new Date('2026-09-18T12:00:00Z');
const LATER = new Date('2026-10-18T12:00:00Z');
const EARLIER = new Date('2026-08-18T12:00:00Z');

function reader(tenantType: string | null, rows: TenantEntitlementRow[]) {
  const findUnique = vi.fn(async () => (tenantType ? { tenantType } : null));
  const findMany = vi.fn(async () => rows);
  return { db: { tenant: { findUnique }, tenantFeatureEntitlement: { findMany } }, findUnique, findMany };
}

describe('TenantEntitlements.check — enabled, not expired, any source (F-018-g, tenant invariant 6)', () => {
  it('allows an enabled row with no expiry and reports its source', async () => {
    const r = reader('reseller', [{ source: 'package_included', expiresAt: null }]);
    const decision = await new TenantEntitlements(r.db).check(TENANT, 'coupon_engine', NOW);

    expect(decision).toEqual({ allowed: true, source: 'package_included', expiresAt: null });
    expect(r.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, featureKey: 'coupon_engine', isEnabled: true },
      select: { source: true, expiresAt: true },
    });
  });

  it('denies a key with no enabled row — a disabled row is never read as a grant', async () => {
    const r = reader('reseller', []);
    expect(await new TenantEntitlements(r.db).allows(TENANT, 'coupon_engine', NOW)).toBe(false);
  });

  it('denies when every enabled row has expired', async () => {
    const r = reader('reseller', [{ source: 'addon_purchased', expiresAt: EARLIER }, { source: 'admin_granted', expiresAt: NOW }]);
    expect(await new TenantEntitlements(r.db).check(TENANT, 'spin_wheel', NOW)).toEqual({ allowed: false });
  });

  it('any live source is enough, and the one that lasts longest is reported', async () => {
    const r = reader('reseller', [
      { source: 'addon_purchased', expiresAt: EARLIER },
      { source: 'admin_granted', expiresAt: LATER },
      { source: 'addon_purchased', expiresAt: new Date('2026-09-20T00:00:00Z') },
    ]);
    expect(await new TenantEntitlements(r.db).check(TENANT, 'spin_wheel', NOW)).toEqual({
      allowed: true,
      source: 'admin_granted',
      expiresAt: LATER,
    });
  });

  it('the platform owner is entitled to every key without a row (user, 2026-09-18)', async () => {
    const r = reader('platform_owner', []);
    expect(await new TenantEntitlements(r.db).check(TENANT, 'dedicated_node_pool', NOW)).toEqual({
      allowed: true,
      source: 'platform_owner',
      expiresAt: null,
    });
    expect(r.findMany).not.toHaveBeenCalled();
  });

  it('an unknown tenant is denied', async () => {
    const r = reader(null, [{ source: 'package_included', expiresAt: null }]);
    expect(await new TenantEntitlements(r.db).allows(TENANT, 'coupon_engine', NOW)).toBe(false);
  });
});

describe('RequiresFeature + TenantEntitlementGuard', () => {
  class Routes {
    @RequiresFeature('coupon_engine')
    redeem(): void {}
  }

  const run = (db: ReturnType<typeof reader>['db'], tenant: string | null = TENANT) => {
    const guard = new TenantEntitlementGuard(new Reflector(), new TenantEntitlements(db));
    const context = { getHandler: () => Routes.prototype.redeem, getClass: () => Routes };
    return runWithTenant(tenant ? { id: tenant } : null, () => guard.canActivate(context as never));
  };

  it('the decorator attaches the guard, so a route cannot declare a key and go unchecked', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, Routes.prototype.redeem)).toContain(TenantEntitlementGuard);
  });

  it('lets an entitled tenant through', async () => {
    await expect(run(reader('reseller', [{ source: 'package_included', expiresAt: null }]).db)).resolves.toBe(true);
  });

  it('refuses a tenant without the key with the one error code', async () => {
    await expect(run(reader('reseller', []).db)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run(reader('reseller', []).db)).rejects.toMatchObject({
      response: { i18nKey: 'tenant.featureNotEntitled', reason: 'tenantFeatureNotEntitled' },
    });
  });

  it('refuses a gated route with no tenant in scope — a feature is always some tenant’s', async () => {
    const r = reader('reseller', [{ source: 'package_included', expiresAt: null }]);
    await expect(run(r.db, null)).rejects.toMatchObject({ response: { reason: 'tenantFeatureNotEntitled' } });
    expect(r.findUnique).not.toHaveBeenCalled();
  });
});
