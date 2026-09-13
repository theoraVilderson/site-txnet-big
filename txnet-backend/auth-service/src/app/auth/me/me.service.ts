import { Injectable } from '@nestjs/common';
import { TenantType } from '@prisma/client';
import { err, ok } from '@txnet-backend/shared-core';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthClaims } from '../token.service';

export type Me = {
  userId: string;
  fullName: string;
  role: { id: string; name: string };
  /** Exactly the list in the access token — see the note on `describe`. */
  permissions: string[];
  tenant: { id: string; type: TenantType };
  isImpersonated: boolean;
  impersonatedBy?: string;
};

/**
 * Who the caller is and what it may do (F-097).
 *
 * This is the answer that replaced a role word in the URL (D-28): there is one
 * panel, and an operator sees more of it because of the permissions they hold,
 * never because of a different path. A surface asks this once and renders from
 * it; nothing infers authority from where it was loaded.
 */
@Injectable()
export class MeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * **Role and permissions come from the claims, not from the database.**
   *
   * `forward-auth` gates every other service on the token's `permissions[]`
   * (identity/contract.md), so this route has to answer the same list or the two
   * disagree for as long as the token lives. Re-reading
   * `identity.role_permission` here would make a freshly granted key visible on
   * the screen while the edge still refuses it — a button that 403s — and a
   * freshly revoked one invisible while it still works. The token is the
   * authority; a change to a role takes effect on the next refresh, which is
   * what `JWT_ACCESS_TTL_SEC` already means everywhere else.
   *
   * The **tenant type** is the one thing no claim carries and therefore the one
   * read. It is not decoration: `audit`'s settlement routes check
   * `TenantType.platform_owner` as a second door precisely because the
   * permission is not the boundary — a reseller administers its own roles
   * (`domains/audit/contract.settlement.md`, invariant #9). A surface gated on
   * the permission alone would offer an operator screen to a reseller that
   * granted itself the key.
   *
   * The user row is read at all so that a suspended or deleted account stops
   * being described: `AuthGuard` proves the *session* is live, which is not the
   * same question.
   */
  async describe(claims: AuthClaims) {
    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: {
        id: true,
        fullName: true,
        status: true,
        deletedAt: true,
        tenant: { select: { id: true, tenantType: true } },
      },
    });

    if (!user || user.status !== 'active' || user.deletedAt) {
      return err('auth.invalidCredentials');
    }

    const me: Me = {
      userId: user.id,
      fullName: user.fullName,
      role: { id: claims.roleId, name: claims.roleName },
      // Copied, so the caller cannot mutate the verified claims object the
      // guard left on the request.
      permissions: [...claims.permissions],
      tenant: { id: user.tenant.id, type: user.tenant.tenantType },
      isImpersonated: claims.isImpersonated === true,
    };
    if (claims.impersonatedBy) me.impersonatedBy = claims.impersonatedBy;

    return ok(me, 'auth.me');
  }
}
