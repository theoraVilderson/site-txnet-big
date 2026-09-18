import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { TenantContext } from '../../tenant-context/tenant-context';
import type { ResolvedTenant } from '../../tenant/tenant';

/**
 * A reseller's owner signs in on the reseller's domain with their own account,
 * which lives in another tenant — usually the platform's (ADR-0059 (3)) — and
 * switches accounts there among those the domain admits (F-061-g).
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
    const ownerUserId = await this.ownerOf(surface);
    if (!ownerUserId) return null;

    const user = await this.all.user.findFirst({
      where: { ...where, id: ownerUserId, tenantId: { not: surface.id } },
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

  // --- who may hold a session on this door (F-061-g) ------------------------

  /**
   * The door this request came through, as a scope of its own: the tenant
   * whose domain or bot it is. On a `panel` surface that is the brand when the
   * request runs in its owner's tenant, and always `via: 'domain'`, so a
   * lookup run inside it may still fall back to the owner (`ownerMatching`).
   * Anything that is not a panel door — a bot call, no surface — is the
   * ambient tenant unchanged.
   */
  surface(): ResolvedTenant | null {
    const current = TenantContext.currentOrNull();
    if (!current || current.surfacePurpose !== 'panel') return current;
    const door = current.brand ?? current;
    return { id: door.id, slug: door.slug, via: 'domain', surfacePurpose: 'panel' };
  }

  /**
   * The live accounts among `ids` that this door admits (ADR-0059 (1)): its
   * own tenant's, and on a panel its owner. What account switching may list —
   * a member outside this set would be refused on its first request here.
   */
  async admissibleUsers<S extends Prisma.UserSelect>(ids: string[], select: S) {
    const admitted = await this.admitted();
    if (!admitted) return [];
    return this.all.user.findMany({
      where: { id: { in: ids }, status: 'active', deletedAt: null, OR: admitted },
      select,
    });
  }

  /** One account, when this door admits it; its state is the caller's to judge. */
  async admissibleUser<I extends Prisma.UserInclude>(id: string, include: I) {
    const admitted = await this.admitted();
    if (!admitted) return null;
    return this.all.user.findFirst({ where: { id, OR: admitted }, include });
  }

  /** The admission rule as a filter, or `null` outside any tenant. */
  private async admitted(): Promise<Prisma.UserWhereInput[] | null> {
    const door = this.surface();
    if (!door) return null;
    const owner = await this.ownerOf(door);
    return [{ tenantId: door.id }, ...(owner ? [{ id: owner }] : [])];
  }

  /** The owner a panel door admits besides its own tenant; none elsewhere. */
  private async ownerOf(door: ResolvedTenant): Promise<string | null> {
    if (door.surfacePurpose !== 'panel') return null;
    const tenant = await this.all.tenant.findUnique({
      where: { id: door.id },
      select: { ownerUserId: true },
    });
    return tenant?.ownerUserId ?? null;
  }
}
