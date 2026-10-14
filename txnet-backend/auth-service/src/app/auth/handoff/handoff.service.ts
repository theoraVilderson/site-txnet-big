import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import {
  DomainVerificationStatus,
  Prisma,
  TenantDomainPurpose,
  TenantDomainType,
  TenantStatus,
  TenantType,
} from '@prisma/client';
import { answersAsPanel, panelHostOf } from '@txnet-backend/shared-core';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys, RedisTtl } from '../../redis/redis.keys';
import { runWithTenant } from '../../tenant-context/tenant-context';
import { ok, err, safeExecute } from '../../common/response/response.util';
import { AuthService } from '../auth.service';
import { SurfaceOwnerService } from '../surface-owner/surface-owner.service';
import { WITH_KEYS } from '../permissions/user-with-keys';
import type { AuthClaims } from '../token.service';

/** What a handoff code stands for: this account, on this tenant's panel. */
type HandoffGrant = { userId: string; tenantId: string };

/**
 * From the platform panel to a reseller's own domain without signing in again
 * (F-061-f, ADR-0059).
 *
 * The owner's session lives on the platform's host, and since ADR-0060 its
 * refresh cookie is host-only — the reseller's domain never sees it. So the
 * platform mints a single-use code naming the account and the reseller, the
 * browser carries it across, and the reseller's domain redeems it for an
 * ordinary session of the same account, exactly as a password sign-in there
 * would open (ADR-0059 (3)).
 *
 * **Why this reads across tenants.** The caller's tenant is the platform's and
 * the reseller is another tenant: which resellers they own, and which host each
 * one's panel answers on, are rows of those tenants. Every read is narrowed to
 * `ownerUserId = caller`.
 */
/** The rows `panelHostOf` judges a reseller's panel host from: panel domains, verified unless a subdomain. */
const PANEL_DOMAINS = {
  where: {
    purpose: TenantDomainPurpose.panel,
    OR: [
      { domainType: TenantDomainType.subdomain },
      { verificationStatus: DomainVerificationStatus.verified },
    ],
  },
  select: { domainValue: true, domainType: true },
} satisfies Prisma.Tenant$domainsArgs;

@Injectable()
export class HandoffService {
  constructor(
    private readonly all: CrossTenantPrismaService,
    private readonly redis: RedisService,
    private readonly surfaceOwners: SurfaceOwnerService,
    private readonly auth: AuthService,
  ) {}

  /**
   * The resellers the caller owns — what the panel offers a button for.
   * `here` marks the one whose panel domain this request came through
   * (F-061-m): there is nowhere to hand off to, so the panel opens its console
   * instead. Read off the resolved door, never another query.
   *
   * `live`: not terminated — the one reseller an owner may hold at a time.
   * `hasPanel`: a handoff to it would land (F-061-n) — the same `panelHostOf`
   * `issue` refuses on, over the same rows, so the sidebar offers "open its
   * panel" only where the click succeeds.
   */
  async owned(claims: AuthClaims) {
    return safeExecute(async () => {
      const owned = await this.all.tenant.findMany({
        where: { ownerUserId: claims.sub, tenantType: TenantType.reseller, deletedAt: null },
        select: { id: true, slug: true, status: true, domains: PANEL_DOMAINS },
        orderBy: { slug: 'asc' },
      });
      const door = this.surfaceOwners.surface();
      const hereId = door?.via === 'domain' ? door.id : null;
      const resellers = owned.map(({ domains, status, ...r }) => ({
        ...r,
        here: r.id === hereId,
        // Not terminated: an owner has one at most (`already_reseller`), and it
        // is the one the panel opens at the id-less `/reseller` (F-061-n).
        live: status !== TenantStatus.terminated,
        hasPanel: panelHostOf(domains ?? [], TenantType.reseller) !== null,
      }));
      return ok({ resellers }, 'auth.handoffResellers');
    });
  }

  /**
   * Mint a code for one reseller the caller owns, and say which origin to
   * spend it on. An impersonated session is refused: what it would hand over
   * is an ordinary session, which outlives the impersonation's audited window
   * (identity invariant #7).
   */
  async issue(claims: AuthClaims, tenantId: string) {
    return safeExecute(async () => {
      if (claims.isImpersonated) return err('auth.handoffRefused');

      const reseller = await this.all.tenant.findFirst({
        where: { id: tenantId, ownerUserId: claims.sub, tenantType: TenantType.reseller, deletedAt: null },
        select: {
          id: true,
          domains: PANEL_DOMAINS,
        },
      });
      const host = reseller ? panelHostOf(reseller.domains, TenantType.reseller) : null;
      if (!reseller || !host) return err('auth.handoffRefused');

      const code = randomBytes(32).toString('base64url');
      const grant: HandoffGrant = { userId: claims.sub, tenantId: reseller.id };
      await this.redis.set(RedisKeys.handoff(code), JSON.stringify(grant), RedisTtl.handoff);
      return ok(
        { origin: `https://${host}`, code, expiresIn: RedisTtl.handoff },
        'auth.handoffIssued',
      );
    });
  }

  /**
   * Spend a code on the reseller's panel domain. Every refusal is the same
   * `auth.handoffInvalid`: a code is a bearer credential, and the answer must
   * not say which part of it was wrong.
   *
   * A code shown on another domain is refused *without* being spent — only its
   * own domain can spend it anyway. On its own domain it is deleted before the
   * account is read, and only the caller whose `DEL` removed it goes on, so two
   * redemptions racing cannot both open a session.
   */
  async redeem(code: string, ip: string, userAgent: string, scopeKey: string | null, currentRefreshToken?: string) {
    return safeExecute(async () => {
      const door = this.surfaceOwners.surface();
      const key = RedisKeys.handoff(code);
      const grant = parseGrant(await this.redis.client.get(key));
      if (!grant || !answersAsPanel(door?.surfacePurpose) || grant.tenantId !== door?.id) {
        return err('auth.handoffInvalid');
      }
      if ((await this.redis.client.del(key)) !== 1) return err('auth.handoffInvalid');

      const owner = await this.surfaceOwners.ownerById(grant.userId, WITH_KEYS);
      if (!owner || owner.user.status !== 'active' || owner.user.deletedAt) return err('auth.handoffInvalid');

      // Already signed in here as the same account (F-061-o, user 2026-10-08):
      // keep that session — the code is spent, nothing new is opened and no
      // cookie is set, and the panel goes to its dashboard. Signed in as
      // somebody else, or not at all, the owner gets its own session as before.
      if (currentRefreshToken && (await this.auth.liveSessionUserId(currentRefreshToken)) === grant.userId) {
        return ok({ alreadySignedIn: true as const }, 'auth.handoffAlreadySignedIn');
      }

      const session = await runWithTenant(owner.scope, () =>
        this.auth.createSessionForUser(owner.user, ip, userAgent, scopeKey),
      );
      return ok(session, 'auth.loginSuccess');
    });
  }
}

function parseGrant(raw: string | null): HandoffGrant | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<HandoffGrant>;
    return typeof value?.userId === 'string' && typeof value.tenantId === 'string'
      ? { userId: value.userId, tenantId: value.tenantId }
      : null;
  } catch {
    return null;
  }
}
