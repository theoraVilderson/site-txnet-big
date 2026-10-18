import { AdminAction, AuditTargetType, Prisma } from '@prisma/client';
import { isPlatformTenant } from '@txnet-backend/shared-core';

import type { PrismaService } from '../prisma/prisma.service';
import { TenantPackageRefused } from './tenant-package.refusal';

/** Who administers packages, as `forward-auth` proved them, and the address a write is audited from. */
export type TenantPackageActor = { adminId: string; tenantId: string; ip: string };

/** Only the platform owner's tenant administers packages — the same check as reseller administration. */
export async function platformOwnerOnly(prisma: Pick<PrismaService, 'tenant'>, actor: TenantPackageActor): Promise<void> {
  const tenant = await prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
  if (!isPlatformTenant(tenant?.tenantType)) {
    throw new TenantPackageRefused('not_platform_owner', 'package administration');
  }
}

/** One audit row on a package, carrying the platform owner's tenant (the package table has none). */
export function packageAudit(
  actor: TenantPackageActor,
  action: AdminAction,
  id: string,
  oldValue: object | null,
  newValue: object,
): Prisma.AdminAuditLogUncheckedCreateInput {
  return {
    tenantId: actor.tenantId,
    adminId: actor.adminId,
    action,
    targetEntityType: AuditTargetType.tenant_feature_package,
    targetEntityId: id,
    oldValue: oldValue ? (oldValue as Prisma.InputJsonValue) : Prisma.JsonNull,
    newValue: newValue as Prisma.InputJsonValue,
    adminIpAddress: actor.ip,
  };
}
