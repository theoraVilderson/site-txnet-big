import { Injectable, UnauthorizedException } from '@nestjs/common';
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

export type AuthClaims = {
  sub: string;
  tenantId: string;
  roleId: string;
  permissions: string[];
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
    return this.sign({
      sub: user.id,
      tenantId: user.tenantId,
      roleId: user.roleId,
      permissions,
      sessionId,
    });
  }

  signOtpToken(userId: string): string {
    return this.sign(
      {
        sub: userId,
        tenantId: '',
        roleId: '',
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
        permissions,
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
      throw new UnauthorizedException('token expired');
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
