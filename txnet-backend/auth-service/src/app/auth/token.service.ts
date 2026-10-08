import { Injectable, UnauthorizedException } from '@nestjs/common';
import { permissionFingerprint } from './permissions/permission-fingerprint';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * The TTL keys `envSchema` owns. They are validated at boot with real
 * defaults (`config/env.validation.ts`), so this service never carries a
 * second copy of a number: an absent TTL is a misconfiguration, not a value
 * to guess. See BACKLOG F-054.
 */
type TokenTtlKey =
  | 'JWT_ACCESS_TTL_SEC'
  | 'OTP_TOKEN_TTL_SEC'
  | 'RESET_TOKEN_TTL_SEC'
  | 'IMPERSONATION_TOKEN_TTL_SEC';

export type RoleScope = 'system' | 'tenant';

/** `role.tenantId` null is a system template every tenant reads (F-018-n). */
const roleScopeOf = (role: { tenantId?: string | null } | undefined): RoleScope =>
  role?.tenantId ? 'tenant' : 'system';

export type AuthClaims = {
  sub: string;
  tenantId: string;
  roleId: string;
  /**
   * `identity.role.name`. `forward-auth` keys its policy file by it: `roleId`
   * is a UUID that differs on every seed and cannot address a checked-in file
   * (ADR-0037).
   */
  roleName: string;
  /**
   * `tenant` for a role a tenant made, `system` for a template. The gate checks
   * a tenant's role by its grants against a ceiling, never by its name, which
   * the tenant chose (F-018-n2). Absent on single-purpose tokens.
   */
  roleScope?: RoleScope;
  permissions: string[];
  /**
   * `permissionFingerprint(permissions)` at mint time. The gate and `AuthGuard`
   * refuse the token once the role's fingerprint in Redis differs (ADR-0043).
   * Absent on tokens minted before that shipped, and on single-purpose tokens.
   */
  permHash?: string;
  /**
   * The account is restricted (`suspended`, ADR-0133): `permissions` is empty
   * and the gate and `AuthGuard` admit the token only on their allow-lists —
   * the person's own support conversations, `me`, sign-out. Absent otherwise.
   */
  restricted?: boolean;
  sessionId: string;
  passwordVersion?: number;
  isImpersonated?: boolean;
  impersonatedBy?: string;
  purpose?: string;
  iat: number;
  exp: number;
};

@Injectable()
export class TokenService {
  private readonly accessSecret: string;
  private readonly refreshHashSecret: string;

  constructor(private readonly config: ConfigService) {
    this.accessSecret =
      this.config.get<string>('JWT_ACCESS_SECRET') ||
      this.config.get<string>('JWT_SECRET') ||
      (() => {
        throw new Error('JWT_ACCESS_SECRET is required');
      })();
    this.refreshHashSecret =
      this.config.get<string>('JWT_REFRESH_HASH_SECRET') || this.accessSecret;
  }

  sign(claims: Omit<AuthClaims, 'iat' | 'exp'>, ttlSec?: number): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      ...claims,
      iat: now,
      exp: now + (ttlSec ?? this.ttl('JWT_ACCESS_TTL_SEC')),
    };
    return this.signPayload(payload);
  }

  signAccessToken(user: any, sessionId: string): string {
    const permissions =
      user.role?.rolePermissions?.map((rp: any) => rp.permission.key) ?? [];
    // Anything but `active` is restricted — a caller that forgot to read the
    // status gets the narrow token, never the whole one (ADR-0133). A banned
    // account never reaches here: every sign-in path refuses it first.
    const restricted = user.status !== 'active';
    return this.sign({
      sub: user.id,
      tenantId: user.tenantId,
      roleId: user.roleId,
      roleName: user.role?.name ?? '',
      roleScope: roleScopeOf(user.role),
      permissions: restricted ? [] : permissions,
      // The role's own fingerprint even when restricted, or ADR-0043's
      // staleness rule would answer `permissionsChanged` on every request.
      permHash: permissionFingerprint(permissions),
      ...(restricted ? { restricted: true } : {}),
      sessionId,
    });
  }

  signOtpToken(userId: string): string {
    return this.sign(
      {
        sub: userId,
        tenantId: '',
        roleId: '',
        roleName: '',
        permissions: [],
        sessionId: '',
        purpose: 'otp_login',
      },
      this.ttl('OTP_TOKEN_TTL_SEC'),
    );
  }

  signResetToken(phoneNumber: string, userId: string): string {
    return this.sign(
      {
        sub: userId,
        tenantId: '',
        roleId: '',
        roleName: '',
        permissions: [],
        sessionId: '',
        purpose: 'password_reset',
      },
      this.ttl('RESET_TOKEN_TTL_SEC'),
    );
  }

  signImpersonatedToken(
    targetUser: any,
    sessionId: string,
    adminId: string,
  ): string {
    const permissions =
      targetUser.role?.rolePermissions?.map((rp: any) => rp.permission.key) ??
      [];
    return this.sign(
      {
        sub: targetUser.id,
        tenantId: targetUser.tenantId,
        roleId: targetUser.roleId,
        roleName: targetUser.role?.name ?? '',
        roleScope: roleScopeOf(targetUser.role),
        permissions,
        permHash: permissionFingerprint(permissions),
        sessionId,
        isImpersonated: true,
        impersonatedBy: adminId,
      },
      this.ttl('IMPERSONATION_TOKEN_TTL_SEC'),
    );
  }

  verify(token: string): AuthClaims {
    const parts = token.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('invalid token');

    const expected = createHmac('sha256', this.accessSecret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest('base64url');

    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(parts[2]);

    // A different length already means an invalid signature; we check this
    // before timingSafeEqual, since otherwise it throws a RangeError itself
    // and turns into a 500.
    if (
      expectedBuf.length !== actualBuf.length ||
      !timingSafeEqual(expectedBuf, actualBuf)
    ) {
      throw new UnauthorizedException('invalid token');
    }

    let payload: AuthClaims;
    try {
      payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString(),
      ) as AuthClaims;
    } catch {
      throw new UnauthorizedException('invalid token');
    }

    // A payload with no `exp` at all must not read as "never expires":
    // `undefined <= now` is false. auth-handler already rejects it (Go zero
    // value 0), so this keeps the two validators in step.
    if (
      typeof payload.exp !== 'number' ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      // `reason` is what the panel refreshes on (the gate answers the same).
      throw new UnauthorizedException({
        i18nKey: 'auth.tokenExpired',
        reason: 'tokenExpired',
      });
    }
    return payload;
  }

  refreshHash(token: string): string {
    return createHmac('sha256', this.refreshHashSecret)
      .update(token)
      .digest('hex');
  }

  newRefreshToken(): string {
    return randomBytes(64).toString('base64url');
  }

  private ttl(key: TokenTtlKey): number {
    const seconds = Number(this.config.get(key));
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`${key} is required`);
    }
    return seconds;
  }

  private signPayload(payload: Record<string, any>): string {
    const encodedHeader = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    ).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
      'base64url',
    );
    const signature = createHmac('sha256', this.accessSecret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');
    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }
}
