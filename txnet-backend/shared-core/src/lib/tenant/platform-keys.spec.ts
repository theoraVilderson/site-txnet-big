import { PERMISSION_REGISTRY } from '../http/permission-registry.generated';
import { holdsPermission } from '../http/permissions';
import { PLATFORM_KEYS, PlatformStaffReader, isPlatformKey, isPlatformStaff } from './platform-keys';
import { RESELLER_KEYS } from './reseller-keys';

/**
 * The invariant AC-1-c turns on (catalog §3.3, ADR-0135): the platform's staff
 * permissions are a **separate set**, never granted to a tenant role, and a
 * platform-staff token is never a tenant token — nor the reverse. Both
 * directions are pinned here:
 *
 * - **platform -> tenant**: no platform key is a reseller key, none covers one,
 *   and none is inside the tenant ceiling, so holding the whole platform set
 *   opens no reseller surface as one of its staff;
 * - **tenant -> platform**: a platform key counts only for a caller signed in
 *   to the platform owner's tenant — a reseller's user holding it (or `*`) is
 *   not platform staff, whatever their token claims.
 *
 * The gate's half (a tenant-made role claiming a platform key is refused) is
 * `auth-handler/internal/auth/engine_test.go`; the role editor's (no tenant
 * role may be given one) is `roles.spec.ts`.
 */
describe('platform keys (AC-1-c)', () => {
  const PLATFORM = '11111111-1111-1111-1111-111111111111';
  const RESELLER = '22222222-2222-2222-2222-222222222222';
  const reader = {
    tenant: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        ({ [PLATFORM]: { tenantType: 'platform_owner' }, [RESELLER]: { tenantType: 'reseller' } })[where.id] ?? null,
      ),
    },
  } as unknown as PlatformStaffReader;

  it('names the catalog set, all under `platform.`, all platform-only in the registry', () => {
    expect([...PLATFORM_KEYS].sort()).toEqual(
      [
        'platform.impersonate',
        'platform.node.manage',
        'platform.plan.assign',
        'platform.report.read',
        'platform.tenant.create',
        'platform.tenant.manage',
      ].sort(),
    );
    const registry = new Map<string, { platformOnly: boolean }>(PERMISSION_REGISTRY.map((row) => [row.permission, row]));
    for (const key of PLATFORM_KEYS) {
      expect(isPlatformKey(key), key).toBe(true);
      expect(registry.get(key), key).toMatchObject({ platformOnly: true });
    }
    // And every registry key under `platform.` is one of them: the prefix is the set.
    expect(PERMISSION_REGISTRY.filter((row) => isPlatformKey(row.permission)).map((row) => row.permission).sort()).toEqual(
      [...PLATFORM_KEYS].sort(),
    );
  });

  it('platform -> tenant: the whole platform set opens no reseller key', () => {
    for (const key of RESELLER_KEYS) {
      expect(isPlatformKey(key), key).toBe(false);
      expect(holdsPermission([...PLATFORM_KEYS], key), key).toBe(false);
    }
    const ceiling = PERMISSION_REGISTRY.filter((row) => !row.platformOnly).map((row) => row.permission);
    expect(ceiling.filter(isPlatformKey)).toEqual([]);
  });

  it("tenant -> platform: a platform key counts only for a caller signed in to the platform's tenant", async () => {
    const staff = { tenantId: PLATFORM, permissions: ['platform.report.read'] };
    await expect(isPlatformStaff(reader, staff, 'platform.report.read')).resolves.toBe(true);
    // One platform key is not another.
    await expect(isPlatformStaff(reader, staff, 'platform.tenant.create')).resolves.toBe(false);

    // A reseller's user claiming the key, or holding `*`, is not platform staff.
    for (const permissions of [['platform.report.read'], ['*'], [...PLATFORM_KEYS]]) {
      await expect(isPlatformStaff(reader, { tenantId: RESELLER, permissions }, 'platform.report.read'), permissions.join()).resolves.toBe(false);
    }
    // Nor is a caller of a tenant that does not exist.
    await expect(isPlatformStaff(reader, { tenantId: 'nope', permissions: ['*'] }, 'platform.report.read')).resolves.toBe(false);
  });

  it("the platform's `*` holds every platform key", async () => {
    for (const key of PLATFORM_KEYS) {
      await expect(isPlatformStaff(reader, { tenantId: PLATFORM, permissions: ['*'] }, key), key).resolves.toBe(true);
    }
  });
});
