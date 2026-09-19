import { Inject, Injectable } from '@nestjs/common';
import { TenantStatus, TenantType, type PrismaClient } from '@prisma/client';

import { holdsPermission } from '../http/permissions';
import { runWithTenant } from '../tenant-context/tenant-context';
import { TenantCapabilityName, tenantAllows } from './status-policy';

/** The reads the rule needs. An app binds its app pool (`PrismaService`): `tenant.tenant` has no RLS, and a member's seat is their own tenant's row. */
export type ResellerAccessReader = Pick<PrismaClient, 'tenant' | 'tenantStaffMember'>;

/** The DI token an app binds its {@link ResellerAccessReader} to, once, beside its Prisma pools. */
export const RESELLER_ACCESS_READER = Symbol('RESELLER_ACCESS_READER');

/** Who is on the other end, as the service read it from `forward-auth`. */
export type ResellerActor = { userId: string; tenantId: string; permissions: string[] };

/** How the caller got in: the reseller's `ownerUserId`, one of its staff, or the platform owner's staff. */
export type AdmittedReseller = { id: string; slug: string; as: 'owner' | 'member' | 'staff' };

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
 * The one door on every route that configures a named reseller (F-061-h,
 * ADR-0059 (1)): `/api/tenants/:id/...`, and since F-066-w1 any service's
 * `/api/<service>/tenants/:tenantId/...` (ADR-0064 (1)-(2)). Tenant invariant
 * 21 lives here and nowhere else; a service calls it, never copies it.
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
 * **The reseller's own staff are the third door** (F-018-j). A member holds an
 * accepted, unexpired, unrevoked `tenant_staff_member` seat of *this* reseller,
 * signs in to it — so unlike the owner their ambient tenant is the reseller —
 * and holds `tenant.manage` in it, through a role of that tenant (F-018-n).
 * That permission is the same door the platform owner's staff pass, so a
 * reseller decides which of its roles administer it and which do not; a seat
 * alone grants nothing. They are held to their reseller's matrix as the owner
 * is, which `TenantStatusGuard` would do for them anyway.
 *
 * Every fact is read on the app pool — `tenant.tenant` has no RLS, and a
 * member's seat is their own tenant's row — before a caller touches the
 * cross-tenant pool (ADR-0053's order).
 *
 * {@link run} is the admission plus the scope (ADR-0064 (3)): the work runs
 * with the **reseller** as the tenant, so the app pool's RLS sees its rows and
 * not the caller's.
 */
@Injectable()
export class ResellerAccess {
  constructor(@Inject(RESELLER_ACCESS_READER) private readonly prisma: ResellerAccessReader) {}

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
    const member = !staff && !owner && (await this.isMember(actor, reseller.id, now));
    if (!staff && !owner && !member) throw new ResellerAccessRefused('not_allowed', tenantId);
    if (reseller.status === TenantStatus.terminated) throw new ResellerAccessRefused('reseller_terminated', tenantId);

    if (!staff) {
      const state = { status: reseller.status, graceEndsAt: reseller.graceEndsAt?.toISOString() ?? null };
      if (!tenantAllows(state, capability, now)) throw new ResellerAccessRefused('reseller_suspended', tenantId);
    }
    return { id: reseller.id, slug: reseller.slug, as: staff ? 'staff' : owner ? 'owner' : 'member' };
  }

  /**
   * {@link admit}, then `work` with the admitted reseller in scope. A refusal
   * throws before `work` starts. `work` must `await` its queries inside itself
   * (`runWithTenant`'s rule): a Prisma promise returned unawaited runs after
   * the scope has closed.
   */
  async run<T>(
    actor: ResellerActor,
    tenantId: string,
    capability: TenantCapabilityName,
    work: (reseller: AdmittedReseller) => Promise<T>,
    now = new Date(),
  ): Promise<T> {
    const reseller = await this.admit(actor, tenantId, capability, now);
    return runWithTenant({ id: reseller.id }, () => work(reseller));
  }

  /**
   * A live seat on this reseller, held by a caller signed in to it with
   * `tenant.manage`. Both halves are required: the seat says they are on the
   * team, the permission says this team member administers the reseller.
   */
  private async isMember(actor: ResellerActor, resellerId: string, now: Date): Promise<boolean> {
    if (actor.tenantId !== resellerId) return false;
    if (!holdsPermission(actor.permissions, 'tenant.manage')) return false;
    const seat = await this.prisma.tenantStaffMember.findFirst({
      where: { tenantId: resellerId, userId: actor.userId, revokedAt: null, joinedAt: { not: null } },
      select: { accessExpiresAt: true },
    });
    return !!seat && (seat.accessExpiresAt === null || seat.accessExpiresAt > now);
  }
}
