import { Inject, Injectable } from '@nestjs/common';
import { TenantStatus, TenantType, type PrismaClient } from '@prisma/client';

import { ALL_PERMISSIONS, holdsPermission } from '../http/permissions';
import { runWithTenant } from '../tenant-context/tenant-context';
import { tenantTransaction } from '../tenant-context/with-tenant';
import { AccessTrace, PlatformAccessTier, recordPlatformAccess } from './platform-access-trail';
import { TenantCapabilityName, tenantAllows } from './status-policy';
import type { PlatformKey } from './platform-keys';
import type { ResellerKey } from './reseller-keys';
import { liveEmergencyEntry, liveSupportConsent } from './support-consent';
import { isPlatformTenant } from './platform-tenant';

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
 * **The reseller's own people are the third door** (ADR-0139 (2)). A member is
 * a user of *this* reseller, signed in to it — so unlike the owner their
 * ambient tenant is the reseller — holding **the key the route names** (AC-1-e)
 * from any source: a group of that reseller, a key given to them, their role
 * (ADR-0138's one answer, in the token) — the key by name; `*` admits no member. `for('domain.manage')` admits a member
 * holding it and no other. The bare door names no key and admits no member, so
 * a route is the owner's alone until it says otherwise. No seat is asked; a
 * seat that is not live still refuses, because a removed seat kept its role
 * (GR-1-g moves those people to groups and drops that check). They are held to
 * their reseller's matrix as the owner is, which `TenantStatusGuard` would do
 * for them anyway.
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

  /** The platform keys, any one of which admits the platform's staff, when the route asks other than its default ({@link asStaff}). */
  private staffKeys: readonly PlatformKey[] | null = null;

  constructor(@Inject(RESELLER_ACCESS_READER) private readonly prisma: ResellerAccessReader) {}

  /**
   * This door, opened also to a reseller's own staff member holding **any one**
   * of `keys` (AC-1-e). The owner and the platform's staff are admitted as on
   * the bare door; the keys are the member's door only.
   */
  for(...keys: ResellerKey[]): ResellerAccess {
    const door = new ResellerAccess(this.prisma);
    door.keys = keys;
    door.staffKeys = this.staffKeys;
    return door;
  }

  /**
   * This door, with the platform's staff admitted by any one of `keys` instead
   * of the default — `platform.tenant.manage`, or `platform.report.read` on a
   * figures route (AC-1-d, ADR-0135). Impersonation asks `platform.impersonate`;
   * the support-consent routes `platform.tenant.manage` or `platform.support`
   * (ADR-0141 (3)).
   */
  asStaff(...keys: PlatformKey[]): ResellerAccess {
    const door = new ResellerAccess(this.prisma);
    door.keys = this.keys;
    door.staffKeys = keys;
    return door;
  }

  admit(actor: ResellerActor, tenantId: string, capability: TenantCapabilityName, now = new Date()): Promise<AdmittedReseller> {
    return this.admitTarget(actor, tenantId, capability, now, 'reseller');
  }

  /**
   * {@link admit}, on a route that may also name the platform's own tenant
   * (F-311-aa, D-55): the users-admin routes, one page for every tenant's
   * users, the platform's direct users included. The platform's tenant is
   * admitted to its staff (`platform.tenant.manage` or `*`) and to a user of
   * the platform holding the route's key by name (GR-1-o, ADR-0139 (7)), both
   * answered `staff`; anyone else learns nothing — its `ownerUserId` and a seat
   * on it are no door.
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
    const staffKeys = this.staffKeys ?? [route === 'figures' ? 'platform.report.read' : 'platform.tenant.manage'];
    const fromPlatform = isPlatformTenant(caller?.tenantType);
    const staff = fromPlatform && staffKeys.some((key) => holdsPermission(actor.permissions, key));
    if (platform && tenant && isPlatformTenant(tenant.tenantType)) {
      // Its own people are a tenant's like any other's (GR-1-o, ADR-0139 (7)): a
      // user of the platform holding the route's key by name — its Support group's
      // `grant.read` — is admitted as its staff are. Figures stay staff-only.
      const member = route === 'people' && actor.tenantId === tenant.id && this.holdsRouteKey(actor);
      if (!staff && !member) throw new ResellerAccessRefused('not_allowed', tenantId);
      return { id: tenant.id, slug: tenant.slug, as: 'staff', platform: true };
    }
    const reseller = tenant?.tenantType === TenantType.reseller ? tenant : null;
    // Platform support (ADR-0141 (2)): on a people route only, by the route's own key; admitted as staff, so under consent below.
    const supportAgent = !staff && route === 'people' && fromPlatform && holdsPermission(actor.permissions, 'platform.support') && this.holdsRouteKey(actor);
    const viaPlatform = staff || supportAgent;
    // Only the platform's side learns whether a reseller exists.
    if (!reseller) throw new ResellerAccessRefused(viaPlatform ? 'reseller_not_found' : 'not_allowed', tenantId);
    const owner = reseller.ownerUserId === actor.userId;
    const member = !viaPlatform && !owner && (await this.isMember(actor, reseller.id, now));
    if (!viaPlatform && !owner && !member) throw new ResellerAccessRefused('not_allowed', tenantId);
    const state = { status: reseller.status, graceEndsAt: reseller.graceEndsAt?.toISOString() ?? null };
    // Closed to everyone, save what the terminated column itself opens: taking
    // its data (`dataExport`, F-212-a, catalog §14.8).
    if (reseller.status === TenantStatus.terminated && !tenantAllows(state, capability, now)) {
      throw new ResellerAccessRefused('reseller_terminated', tenantId);
    }

    if (!viaPlatform) {
      if (!tenantAllows(state, capability, now)) throw new ResellerAccessRefused('reseller_suspended', tenantId);
    } else if (route === 'people' && !owner) {
      const support = await this.mustHoldConsent(actor, reseller.id, capability, now);
      return { id: reseller.id, slug: reseller.slug, as: 'staff', support };
    }
    return { id: reseller.id, slug: reseller.slug, as: viaPlatform ? 'staff' : owner ? 'owner' : 'member' };
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

  /** One of the route's keys, by name, never `*`: a tenant user holding `*` is a mistake, not a grant (groups cannot give it, ADR-0138 (7)). */
  private holdsRouteKey(actor: ResellerActor): boolean {
    const named = actor.permissions.filter((key) => key !== ALL_PERMISSIONS);
    return this.keys.some((key) => holdsPermission(named, key));
  }

  /**
   * A caller signed in to this reseller holding one of this door's keys — the
   * key is what says they may do what this route does (ADR-0139 (2)). A seat
   * of theirs that is not live (invited and not accepted, expired, removed)
   * refuses: a removed seat kept its role and so its keys. GR-1-g drops this.
   */
  private async isMember(actor: ResellerActor, resellerId: string, now: Date): Promise<boolean> {
    if (actor.tenantId !== resellerId) return false;
    if (!this.holdsRouteKey(actor)) return false;
    const seat = await this.prisma.tenantStaffMember.findFirst({
      where: { tenantId: resellerId, userId: actor.userId },
      select: { joinedAt: true, accessExpiresAt: true, revokedAt: true },
    });
    if (!seat) return true;
    return seat.revokedAt === null && seat.joinedAt !== null && (seat.accessExpiresAt === null || seat.accessExpiresAt > now);
  }
}
