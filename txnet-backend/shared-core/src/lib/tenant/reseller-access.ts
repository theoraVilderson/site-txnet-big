import { Inject, Injectable } from '@nestjs/common';
import { TenantStatus, TenantType, type PrismaClient } from '@prisma/client';

import { holdsPermission } from '../http/permissions';
import { runWithTenant } from '../tenant-context/tenant-context';
import { tenantTransaction } from '../tenant-context/with-tenant';
import { AccessTrace, PlatformAccessTier, recordPlatformAccess } from './platform-access-trail';
import { TenantCapabilityName, tenantAllows } from './status-policy';
import type { PlatformKey } from './platform-keys';
import type { ResellerKey } from './reseller-keys';
import { liveEmergencyEntry, liveSupportConsent } from './support-consent';

/**
 * The reads the rule needs. An app binds its app pool (`PrismaService`): `tenant.tenant` has no RLS, and a member's seat is their own tenant's row.
 * `$transaction` reads the reseller's support consent (F-117-b): that table is under RLS, so it is read in a tenant transaction bound to the reseller.
 */
export type ResellerAccessReader = Pick<PrismaClient, 'tenant' | 'tenantStaffMember' | '$transaction'>;

/** The DI token an app binds its {@link ResellerAccessReader} to, once, beside its Prisma pools. */
export const RESELLER_ACCESS_READER = Symbol('RESELLER_ACCESS_READER');

/**
 * Who is on the other end, as the service read it from `forward-auth`. `trace`
 * is the request (`accessTraceOf`): a platform staff member's admission under
 * consent is recorded with it (F-117-c), so a users-admin controller passes it.
 */
export type ResellerActor = { userId: string; tenantId: string; permissions: string[]; trace?: AccessTrace };

/** How the caller got in: the reseller's `ownerUserId`, one of its staff, or the platform owner's staff. */
/**
 * `platform` is present only when `…IncludingPlatform` admitted the platform's own
 * tenant (F-311-ab1): a read by tenant then names that tenant's catalog rows as
 * `tenantId` null, not by this id.
 */
export type AdmittedReseller = { id: string; slug: string; as: 'owner' | 'member' | 'staff'; platform?: true; support?: SupportAdmission };

/**
 * What let platform staff in to a reseller's people (`…IncludingPlatform` only):
 * the consent (tier B) or their emergency entry (tier C), and when it ends. A
 * session minted on it — impersonation (F-117-e) — ends no later than `endsAt`.
 */
export type SupportAdmission = { tier: PlatformAccessTier; consentId?: string; entryId?: string; endsAt: Date };

export type ResellerAccessRejection = 'not_allowed' | 'reseller_not_found' | 'reseller_suspended' | 'reseller_terminated';

/**
 * Why the platform's staff were refused a reseller's people (F-117-b, ADR-0104
 * (4)): no live consent, or a `read` one on a route that writes. A type of its
 * own, apart from {@link ResellerAccessRejection}: only the users-admin routes
 * (`…IncludingPlatform`) can meet it, so no configuration route maps it.
 */
export type SupportConsentRejection = 'consent_required' | 'consent_read_only';

export class SupportConsentRefused extends Error {
  constructor(
    readonly reason: SupportConsentRejection,
    detail = '',
  ) {
    super(`support consent refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'SupportConsentRefused';
  }
}

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
 * and holds, through a role of that tenant (F-018-n), **the key the route
 * names** (AC-1-e): `for('domain.manage')` admits a member holding it and no
 * other. The bare door names no key and admits no member, so a route is the
 * owner's alone until it says otherwise. A seat alone grants nothing. They are
 * held to their reseller's matrix as the owner is, which `TenantStatusGuard`
 * would do for them anyway.
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
  /** The keys that admit a member; none on the bare door, which is owner-only. Not a constructor parameter: Nest injects this class. */
  private keys: readonly ResellerKey[] = [];

  /** The platform key that admits the platform's staff, when the route asks another than its default ({@link asStaff}). */
  private staffKey: PlatformKey | null = null;

  constructor(@Inject(RESELLER_ACCESS_READER) private readonly prisma: ResellerAccessReader) {}

  /**
   * This door, opened also to a reseller's own staff member holding **any one**
   * of `keys` (AC-1-e). The owner and the platform's staff are admitted as on
   * the bare door; the keys are the member's door only.
   */
  for(...keys: ResellerKey[]): ResellerAccess {
    const door = new ResellerAccess(this.prisma);
    door.keys = keys;
    door.staffKey = this.staffKey;
    return door;
  }

  /**
   * This door, with the platform's staff admitted by `key` instead of the
   * default — `platform.tenant.manage`, or `platform.report.read` on a figures
   * route (AC-1-d, ADR-0135). Impersonation asks `platform.impersonate`.
   */
  asStaff(key: PlatformKey): ResellerAccess {
    const door = new ResellerAccess(this.prisma);
    door.keys = this.keys;
    door.staffKey = key;
    return door;
  }

  admit(actor: ResellerActor, tenantId: string, capability: TenantCapabilityName, now = new Date()): Promise<AdmittedReseller> {
    return this.admitTarget(actor, tenantId, capability, now, 'reseller');
  }

  /**
   * {@link admit}, on a route that may also name the platform's own tenant
   * (F-311-aa, D-55): the users-admin routes, one page for every tenant's
   * users, the platform's direct users included. The platform's tenant is
   * admitted to **its staff only** (`platform.tenant.manage` or `*`) and to nobody
   * else, who learns nothing — its `ownerUserId` and a seat on it are no door.
   * A reseller is answered as {@link admit} answers it, with one more rule
   * for the platform's staff (F-117-b, ADR-0104 (4)): these routes name a
   * reseller's **people**, so staff reach them only under that reseller's live
   * consent, read on every call (a revoke ends access on the next one), and a
   * `read` consent admits `read` alone — {@link SupportConsentRefused}. The
   * owner, its members and the platform's own tenant need none. Every other
   * route keeps {@link admit}: configuring a reseller is tier A, no consent,
   * and configuring the platform (its domains, its brand) is not a reseller
   * route's job.
   */
  admitIncludingPlatform(actor: ResellerActor, tenantId: string, capability: TenantCapabilityName, now = new Date()): Promise<AdmittedReseller> {
    return this.admitTarget(actor, tenantId, capability, now, 'people');
  }

  /**
   * {@link admit}, on a route that answers **figures** and may also name the
   * platform's own tenant (UX-1-r2): a reseller's revenue, and the platform's
   * own on its dashboard. The platform's tenant is admitted to its staff only,
   * as under {@link admitIncludingPlatform}; a reseller is answered exactly as
   * {@link admit} answers it — no consent, because figures are not a
   * reseller's people (ADR-0104 (3): a small cell is hidden instead).
   */
  admitFiguresIncludingPlatform(actor: ResellerActor, tenantId: string, capability: TenantCapabilityName, now = new Date()): Promise<AdmittedReseller> {
    return this.admitTarget(actor, tenantId, capability, now, 'figures');
  }

  private async admitTarget(
    actor: ResellerActor,
    tenantId: string,
    capability: TenantCapabilityName,
    now: Date,
    /** `reseller`: resellers only. `people` and `figures`: the platform's tenant too; `people` holds staff to a reseller's consent. */
    route: 'reseller' | 'people' | 'figures',
  ): Promise<AdmittedReseller> {
    const platform = route !== 'reseller';
    const tenantType = platform ? { in: [TenantType.reseller, TenantType.platform_owner] } : TenantType.reseller;
    const [caller, tenant] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } }),
      this.prisma.tenant.findFirst({
        where: { id: tenantId, tenantType, deletedAt: null },
        select: { id: true, slug: true, tenantType: true, ownerUserId: true, status: true, graceEndsAt: true },
      }),
    ]);
    // The platform's staff door asks a platform key (AC-1-d, ADR-0135): figures are a cross-tenant report.
    const staffKey: PlatformKey = this.staffKey ?? (route === 'figures' ? 'platform.report.read' : 'platform.tenant.manage');
    const staff = caller?.tenantType === TenantType.platform_owner && holdsPermission(actor.permissions, staffKey);
    if (platform && tenant?.tenantType === TenantType.platform_owner) {
      if (!staff) throw new ResellerAccessRefused('not_allowed', tenantId);
      return { id: tenant.id, slug: tenant.slug, as: 'staff', platform: true };
    }
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
    } else if (route === 'people' && !owner) {
      const support = await this.mustHoldConsent(actor, reseller.id, capability, now);
      return { id: reseller.id, slug: reseller.slug, as: 'staff', support };
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

  /** {@link admitFiguresIncludingPlatform}, then `work` in the admitted tenant's scope — {@link run}'s rule. */
  async runFiguresIncludingPlatform<T>(
    actor: ResellerActor,
    tenantId: string,
    capability: TenantCapabilityName,
    work: (reseller: AdmittedReseller) => Promise<T>,
    now = new Date(),
  ): Promise<T> {
    const admitted = await this.admitFiguresIncludingPlatform(actor, tenantId, capability, now);
    return runWithTenant({ id: admitted.id }, () => work(admitted));
  }

  /** {@link admitIncludingPlatform}, then `work` in the admitted tenant's scope — {@link run}'s rule, the platform's tenant included. */
  async runIncludingPlatform<T>(
    actor: ResellerActor,
    tenantId: string,
    capability: TenantCapabilityName,
    work: (reseller: AdmittedReseller) => Promise<T>,
    now = new Date(),
  ): Promise<T> {
    const admitted = await this.admitIncludingPlatform(actor, tenantId, capability, now);
    return runWithTenant({ id: admitted.id }, () => work(admitted));
  }

  /**
   * The reseller's live consent must cover the capability: any scope for `read`,
   * `act` for anything else (tier B). Short of that, this staff member's own
   * running emergency entry admits as `act` (tier C, F-117-d). Admitted, the
   * request is one row in the reseller's trail (F-117-c, ADR-0104 (6)), in the
   * same transaction as the read.
   */
  private async mustHoldConsent(actor: ResellerActor, resellerId: string, capability: TenantCapabilityName, now: Date): Promise<SupportAdmission> {
    return runWithTenant({ id: resellerId }, () =>
      tenantTransaction(this.prisma, async (tx): Promise<SupportAdmission> => {
        const base = { tenantId: resellerId, actorUserId: actor.userId, capability, trace: actor.trace };
        const consent = await liveSupportConsent(tx, resellerId, now);
        if (consent && (capability === 'read' || consent.scope === 'act')) {
          await recordPlatformAccess(tx, { ...base, tier: 'consent', consentId: consent.id, scope: consent.scope });
          return { tier: 'consent', consentId: consent.id, endsAt: consent.expiresAt };
        }
        const entry = await liveEmergencyEntry(tx, resellerId, actor, now);
        if (entry) {
          await recordPlatformAccess(tx, { ...base, tier: 'emergency', entryId: entry.id, scope: 'act' });
          return { tier: 'emergency', entryId: entry.id, endsAt: entry.expiresAt };
        }
        throw new SupportConsentRefused(consent ? 'consent_read_only' : 'consent_required', resellerId);
      }),
    );
  }

  /**
   * A live seat on this reseller, held by a caller signed in to it with one of
   * this door's keys. Both halves are required: the seat says they are on the
   * team, the key says this team member may do what this route does.
   */
  private async isMember(actor: ResellerActor, resellerId: string, now: Date): Promise<boolean> {
    if (actor.tenantId !== resellerId) return false;
    if (!this.keys.some((key) => holdsPermission(actor.permissions, key))) return false;
    const seat = await this.prisma.tenantStaffMember.findFirst({
      where: { tenantId: resellerId, userId: actor.userId, revokedAt: null, joinedAt: { not: null } },
      select: { accessExpiresAt: true },
    });
    return !!seat && (seat.accessExpiresAt === null || seat.accessExpiresAt > now);
  }
}
