import { Injectable } from '@nestjs/common';
import { TenantStatus, TenantType } from '@prisma/client';
import { TenantCapabilityName, holdsPermission, tenantAllows } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';

/** Who is on the other end, as `IdentityMiddleware` read it from `forward-auth`. */
export type ResellerActor = { userId: string; tenantId: string; permissions: string[] };

/** How the caller got in: the reseller's `ownerUserId`, or the platform owner's staff. */
export type AdmittedReseller = { id: string; slug: string; as: 'owner' | 'staff' };

export type ResellerAccessRejection = 'not_allowed' | 'reseller_not_found' | 'reseller_suspended' | 'reseller_terminated';

export class ResellerAccessRefused extends Error {
  constructor(
    readonly reason: ResellerAccessRejection,
    detail = '',
  ) {
    super(`reseller access refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'ResellerAccessRefused';
  }
}

/**
 * The one door on a reseller's self-service routes (F-061-h, ADR-0059 (1)):
 * `/api/tenants/:id/...`, reached by that reseller's owner.
 *
 * **The reseller is the path's, never the ambient tenant.** The owner is a user
 * of the platform owner's tenant, so their session — on the platform's domain
 * or on the reseller's own, where ADR-0059 (1) scopes it to their own tenant —
 * carries the platform's `X-Tenant-Id`. Nothing here reads that id as the
 * reseller; being a user of the reseller's tenant grants nothing either.
 *
 * **The owner is judged by the reseller's status.** `TenantStatusGuard` judges
 * the ambient tenant, which for the owner is always their active platform
 * tenant, so the reseller's matrix (rules.md) is applied here to the
 * capability the route names. Platform staff administer a suspended reseller;
 * a terminated one is closed to everyone.
 *
 * F-018-j's staff join as "owner or staff of this tenant" here, in one place.
 * Both facts are read on the app pool — `tenant.tenant` has no RLS — before a
 * caller touches the cross-tenant pool (ADR-0053's order).
 */
@Injectable()
export class ResellerAccess {
  constructor(private readonly prisma: PrismaService) {}

  async admit(actor: ResellerActor, tenantId: string, capability: TenantCapabilityName, now = new Date()): Promise<AdmittedReseller> {
    const [caller, tenant] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } }),
      this.prisma.tenant.findFirst({
        where: { id: tenantId, tenantType: TenantType.reseller, deletedAt: null },
        select: { id: true, slug: true, tenantType: true, ownerUserId: true, status: true, graceEndsAt: true },
      }),
    ]);
    const staff = caller?.tenantType === TenantType.platform_owner && holdsPermission(actor.permissions, 'tenant.manage');
    const reseller = tenant?.tenantType === TenantType.reseller ? tenant : null;
    // Only staff learns whether a reseller exists.
    if (!reseller) throw new ResellerAccessRefused(staff ? 'reseller_not_found' : 'not_allowed', tenantId);
    const owner = reseller.ownerUserId === actor.userId;
    if (!staff && !owner) throw new ResellerAccessRefused('not_allowed', tenantId);
    if (reseller.status === TenantStatus.terminated) throw new ResellerAccessRefused('reseller_terminated', tenantId);

    if (!staff) {
      const state = { status: reseller.status, graceEndsAt: reseller.graceEndsAt?.toISOString() ?? null };
      if (!tenantAllows(state, capability, now)) throw new ResellerAccessRefused('reseller_suspended', tenantId);
    }
    return { id: reseller.id, slug: reseller.slug, as: staff ? 'staff' : 'owner' };
  }
}
