import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { TenantContext } from '../../tenant-context/tenant-context';
import type { ResolvedTenant } from '../../tenant/tenant';

/**
 * A reseller's owner signs in on the reseller's domain with their own account,
 * which lives in another tenant — usually the platform's (ADR-0059 (3)).
 *
 * **Why this reads across tenants.** The ambient scope of a sign-in on that
 * domain is the reseller's, and the owner's account is by construction not in
 * it. The read is as narrow as the rule: the one account `tenant.ownerUserId`
 * names, matched by the identifier the caller typed, and only when no account
 * of the surface's own tenant matched first. Nobody else's account is ever
 * looked up from here.
 */
@Injectable()
export class SurfaceOwnerService {
  constructor(private readonly all: CrossTenantPrismaService) {}

  /**
   * The surface tenant's owner, when `where` names them, together with the
   * scope the rest of the sign-in runs in: the owner's own tenant, branded by
   * the surface. `null` when there is no panel surface, no owner, or the
   * identifier is someone else's.
   */
  async ownerMatching(
    where: Prisma.UserWhereInput,
    include: Prisma.UserInclude,
  ): Promise<{ user: { id: string; tenantId: string }; scope: ResolvedTenant } | null> {
    const surface = TenantContext.currentOrNull();
    if (!surface || surface.via !== 'domain' || surface.surfacePurpose !== 'panel') {
      return null;
    }
    const tenant = await this.all.tenant.findUnique({
      where: { id: surface.id },
      select: { ownerUserId: true },
    });
    if (!tenant?.ownerUserId) return null;

    const user = await this.all.user.findFirst({
      where: { ...where, id: tenant.ownerUserId, tenantId: { not: surface.id } },
      include: { ...include, tenant: { select: { slug: true } } },
    });
    if (!user) return null;

    const { slug } = (user as unknown as { tenant: { slug: string } }).tenant;
    return {
      user,
      scope: {
        id: user.tenantId,
        slug,
        via: 'session',
        surfacePurpose: surface.surfacePurpose,
        brand: { id: surface.id, slug: surface.slug },
      },
    };
  }
}
