import type { PrismaClient } from '@prisma/client';

import type { RegisteredPermission } from '../http/permission-registry.generated';
import { holdsPermission } from '../http/permissions';
import { isPlatformTenant } from './platform-tenant';

/** Every platform key starts with this, and nothing else does: the prefix is the set (AC-1-c). */
export const PLATFORM_KEY_PREFIX = 'platform.';

/**
 * The platform's staff permissions (AC-1-c, catalog §3.3, ADR-0135): a set of
 * their own, apart from every tenant key. They are held under `SuperAdmin`
 * alone in `permissions.yaml`, so the registry marks them platform-only and no
 * tenant-made role may claim one at the gate (F-018-n2) or be given one by the
 * role editor (`RolesService`).
 *
 *     platform.tenant.create   create a reseller
 *     platform.tenant.manage   administer a reseller: its configuration, and its people under consent
 *     platform.plan.assign     the package and plan a reseller is sold, its subscription and limits
 *     platform.node.manage     the platform's panels and nodes
 *     platform.report.read     figures across tenants
 *     platform.impersonate     sign in as a reseller's user, under consent (F-117-e)
 *     platform.support         a reseller's people under its consent, with the act's own key (ADR-0141)
 *
 * `platform.tenant.manage` is the sixth, beside the catalog's five: the
 * general door into one reseller that `tenant.manage` was (user, 2026-10-09).
 */
export const PLATFORM_KEYS = [
  'platform.tenant.create',
  'platform.tenant.manage',
  'platform.plan.assign',
  'platform.node.manage',
  'platform.report.read',
  'platform.impersonate',
  'platform.support',
] as const satisfies readonly RegisteredPermission[];

/** A key of the platform's set. */
export type PlatformKey = (typeof PLATFORM_KEYS)[number];

export const isPlatformKey = (key: string): boolean => key.startsWith(PLATFORM_KEY_PREFIX);

/** The read {@link isPlatformStaff} needs: the caller's home tenant. `tenant.tenant` has no RLS, so an app pool will do. */
export type PlatformStaffReader = { tenant: Pick<PrismaClient['tenant'], 'findUnique'> };

/**
 * Is this caller the platform's staff for `key`? Signed in to the platform
 * owner's tenant **and** holding the key (`*` holds every key). A token of any
 * other tenant is never platform staff, whatever it claims: that is the
 * tenant -> platform half of §3.3, read from the database rather than trusted
 * from the token.
 */
export async function isPlatformStaff(
  reader: PlatformStaffReader,
  actor: { tenantId: string; permissions: readonly string[] },
  key: PlatformKey,
): Promise<boolean> {
  if (!holdsPermission(actor.permissions, key)) return false;
  const home = await reader.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
  return isPlatformTenant(home?.tenantType);
}
