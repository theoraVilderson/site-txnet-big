import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { TenantPackageController } from '../packages/tenant-package.controller';
import { PackageProductsController, ResellerLimitsController } from '../limits/reseller-limits.controller';
import { ResellerController } from '../resellers/reseller.controller';
import { TenantStatusController } from '../status/tenant-status.controller';
import { TenantSubscriptionController } from '../subscription/tenant-subscription.controller';
import { PLATFORM_KEY_METADATA, PlatformPermissionGuard } from './platform-permission.guard';

/**
 * The invariant AC-1-d turns on (ADR-0135 (5)): the platform's routes ask the
 * platform's own keys, one per route group, instead of `tenant.manage`, and a
 * key counts only for a caller signed in to the platform owner's tenant.
 *
 * - each controller names its key — creating a reseller is
 *   `platform.tenant.create`, reading and running one `platform.tenant.manage`,
 *   what it is sold (packages, subscription, limits) `platform.plan.assign`;
 * - the guard admits the platform's staff holding that key (or `*`) and
 *   refuses one holding another platform key, or `tenant.manage`;
 * - a reseller's user is refused whatever they hold, `*` included (§3.3's
 *   tenant -> platform direction).
 */
describe('PlatformPermissionGuard (AC-1-d)', () => {
  const PLATFORM = '11111111-1111-1111-1111-111111111111';
  const RESELLER = '22222222-2222-2222-2222-222222222222';
  const reflector = new Reflector();
  const prisma = {
    tenant: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        ({ [PLATFORM]: { tenantType: 'platform_owner' }, [RESELLER]: { tenantType: 'reseller' } })[where.id] ?? null,
      ),
    },
  };
  const guard = new PlatformPermissionGuard(reflector, prisma as never);

  const keyOf = (controller: abstract new (...args: never[]) => unknown, method: string) =>
    reflector.getAllAndOverride<string[]>(PLATFORM_KEY_METADATA, [
      (controller.prototype as Record<string, () => unknown>)[method],
      controller,
    ]);

  const context = (controller: abstract new (...args: never[]) => unknown, method: string, tenantId: string, permissions: string[]) =>
    ({
      getHandler: () => (controller.prototype as Record<string, () => unknown>)[method],
      getClass: () => controller,
      switchToHttp: () => ({
        getRequest: () => ({ identity: { userId: 'u-1', tenantId, roleId: 'r', sessionId: 's', permissions } }),
      }),
    }) as unknown as ExecutionContext;

  it('names the platform keys per route group', () => {
    expect(keyOf(ResellerController, 'create')).toEqual(['platform.tenant.create']);
    // Support finds the reseller it helps (ADR-0141 (4)); nothing else of a reseller opens to it.
    expect(keyOf(ResellerController, 'list')).toEqual(['platform.tenant.manage', 'platform.support']);
    expect(keyOf(ResellerController, 'read')).toEqual(['platform.tenant.manage', 'platform.support']);
    expect(keyOf(TenantStatusController, 'change')).toEqual(['platform.tenant.manage']);
    expect(keyOf(TenantPackageController, 'create')).toEqual(['platform.plan.assign']);
    expect(keyOf(TenantSubscriptionController, 'put')).toEqual(['platform.plan.assign']);
    expect(keyOf(ResellerLimitsController, 'table')).toEqual(['platform.plan.assign']);
    expect(keyOf(PackageProductsController, 'list')).toEqual(['platform.plan.assign']);
  });

  it('admits any one of a route\'s keys: `platform.support` reads the reseller list, and changes nothing (GR-1-q)', async () => {
    await expect(guard.canActivate(context(ResellerController, 'list', PLATFORM, ['platform.support']))).resolves.toBe(true);
    await expect(guard.canActivate(context(ResellerController, 'read', PLATFORM, ['platform.support']))).resolves.toBe(true);
    await expect(guard.canActivate(context(ResellerController, 'create', PLATFORM, ['platform.support']))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(context(TenantStatusController, 'change', PLATFORM, ['platform.support']))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(context(ResellerController, 'list', RESELLER, ['platform.support']))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("admits the platform's staff on the route's key, or `*`", async () => {
    await expect(guard.canActivate(context(ResellerController, 'create', PLATFORM, ['platform.tenant.create']))).resolves.toBe(true);
    await expect(guard.canActivate(context(TenantPackageController, 'create', PLATFORM, ['*']))).resolves.toBe(true);
  });

  it('refuses another platform key, and the retired `tenant.manage`', async () => {
    for (const permissions of [['platform.tenant.manage'], ['tenant.manage']]) {
      await expect(guard.canActivate(context(ResellerController, 'create', PLATFORM, permissions)), permissions.join()).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
  });

  it("refuses a reseller's user whatever they hold, `*` included", async () => {
    for (const permissions of [['platform.tenant.create'], ['*']]) {
      await expect(guard.canActivate(context(ResellerController, 'create', RESELLER, permissions)), permissions.join()).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }
  });
});
