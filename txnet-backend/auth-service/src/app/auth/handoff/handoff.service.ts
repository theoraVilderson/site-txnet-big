import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import {
  DomainVerificationStatus,
  TenantDomainPurpose,
  TenantDomainType,
  TenantType,
} from '@prisma/client';
import { panelHostOf } from '@txnet-backend/shared-core';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys, RedisTtl } from '../../redis/redis.keys';
import { runWithTenant } from '../../tenant-context/tenant-context';
import { ok, err, safeExecute } from '../../common/response/response.util';
import { AuthService } from '../auth.service';
import { SurfaceOwnerService } from '../surface-owner/surface-owner.service';
import type { AuthClaims } from '../token.service';

/** What a handoff code stands for: this account, on this tenant's panel. */
type HandoffGrant = { userId: string; tenantId: string };

const ROLE_INCLUDE = {
  role: { include: { rolePermissions: { include: { permission: true } } } },
};

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
@Injectable()
export class HandoffService {
  constructor(
    private readonly all: CrossTenantPrismaService,
    private readonly redis: RedisService,
    private readonly surfaceOwners: SurfaceOwnerService,
    private readonly auth: AuthService,
  ) {}

  /** The resellers the caller owns — what the panel offers a button for. */
  async owned(claims: AuthClaims) {
    return safeExecute(async () => {
      const resellers = await this.all.tenant.findMany({
        where: { ownerUserId: claims.sub, tenantType: TenantType.reseller, deletedAt: null },
        select: { id: true, slug: true },
        orderBy: { slug: 'asc' },
      });
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
          domains: {
            where: {
              purpose: TenantDomainPurpose.panel,
              OR: [
                { domainType: TenantDomainType.subdomain },
                { verificationStatus: DomainVerificationStatus.verified },
              ],
            },
            select: { domainValue: true, domainType: true },
          },
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
  async redeem(code: string, ip: string, userAgent: string, scopeKey: string | null) {
    return safeExecute(async () => {
      const door = this.surfaceOwners.surface();
      const key = RedisKeys.handoff(code);
      const grant = parseGrant(await this.redis.client.get(key));
      if (!grant || door?.surfacePurpose !== 'panel' || grant.tenantId !== door.id) {
        return err('auth.handoffInvalid');
      }
      if ((await this.redis.client.del(key)) !== 1) return err('auth.handoffInvalid');

      const owner = await this.surfaceOwners.ownerById(grant.userId, ROLE_INCLUDE);
      const user = owner?.user as { status?: string; deletedAt?: Date | null } | undefined;
      if (!owner || user?.status !== 'active' || user.deletedAt) return err('auth.handoffInvalid');

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
