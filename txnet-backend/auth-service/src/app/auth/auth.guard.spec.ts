import type { Mock } from 'vitest';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from './auth.guard';
import { AllowRestricted } from './decorators/allow-restricted.decorator';
import { SessionStore } from './session/session.store';
import { PermissionStateStore } from './permissions/permission-state.store';
import { AuthClaims, TokenService } from './token.service';

const ACCESS_SECRET = 'unit-test-access-secret';

// The TTL is configured, not defaulted: TokenService refuses to mint without
// it (F-054), and these guards only care that a token was signed at all.
const stubbed: Record<string, unknown> = {
  JWT_ACCESS_SECRET: ACCESS_SECRET,
  JWT_ACCESS_TTL_SEC: 900,
  OTP_TOKEN_TTL_SEC: 300,
  RESET_TOKEN_TTL_SEC: 300,
  IMPERSONATION_TOKEN_TTL_SEC: 1800,
};

const configStub = {
  get: (key: string, fallback?: unknown) =>
    key in stubbed ? stubbed[key] : fallback,
} as unknown as ConfigService;

const accessClaims: Omit<AuthClaims, 'iat' | 'exp'> = {
  sub: 'user-1',
  tenantId: 'tenant-1',
  roleId: 'role-1',
  roleName: 'user',
  permissions: ['user.read'],
  sessionId: 'session-1',
};

function contextWith(header?: string, switchScope: string | null = null) {
  const request: {
    get: (name: string) => string | undefined;
    user?: unknown;
    switchScope?: string | null;
  } = {
    get: (name: string) =>
      name.toLowerCase() === 'authorization' ? header : undefined,
    // What `SwitchScopeMiddleware` decided from the request itself, before the
    // guard has read the session (ADR-0032).
    switchScope,
  };
  return {
    request,
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
  };
}

describe('AuthGuard', () => {
  let tokens: TokenService;
  let sessions: { read: Mock };
  let permissions: { isStale: Mock };
  let guard: AuthGuard;

  beforeEach(() => {
    tokens = new TokenService(configStub);
    // Say yes to every session id, so the assertions below turn on the token
    // itself and not on an incidental Redis miss.
    sessions = {
      read: vi.fn().mockResolvedValue({ userId: 'user-1', scopeKey: null }),
    };
    permissions = { isStale: vi.fn().mockResolvedValue(false) };
    guard = new AuthGuard(
      tokens,
      sessions as unknown as SessionStore,
      permissions as unknown as PermissionStateStore,
    );
  });

  describe('authorization header', () => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['not a Bearer scheme', 'Basic dXNlcjpwYXNz'],
      ['lowercase bearer', 'bearer sometoken'],
      ['the word Bearer alone', 'Bearer'],
    ])('rejects a request whose header is %s', async (_label, header) => {
      const { context } = contextWith(header);
      await expect(guard.canActivate(context)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    // A page that calls before its session is established sends no credential;
    // `reason` lets the panel get one from the refresh cookie and send again.
    it('names a missing credential so the panel can fetch one', async () => {
      const { context } = contextWith(undefined);
      await expect(guard.canActivate(context)).rejects.toMatchObject({
        response: {
          i18nKey: 'auth.authorizationRequired',
          reason: 'authorizationRequired',
        },
      });
    });
  });

  describe('access tokens', () => {
    it('accepts a valid token and attaches the claims to the request', async () => {
      const { context, request } = contextWith(
        `Bearer ${tokens.sign(accessClaims)}`,
      );

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.user).toMatchObject(accessClaims);
      expect(sessions.read).toHaveBeenCalledWith('session-1');
    });

    it('rejects a token whose session has been revoked', async () => {
      sessions.read.mockResolvedValue(null);
      const { context } = contextWith(`Bearer ${tokens.sign(accessClaims)}`);

      // `reason` lets the panel try its refresh cookie once: a session another
      // tab rotated is mended by it, a real sign-out is not.
      await expect(guard.canActivate(context)).rejects.toMatchObject({
        response: { i18nKey: 'auth.sessionRevoked', reason: 'sessionRevoked' },
      });
    });

    it('refuses a token whose permissions are stale, naming the reason a client acts on', async () => {
      // ADR-0043. The guard's own routes (workers, impersonation) are not behind
      // the gate, so a token the gate refuses must not work here either.
      permissions.isStale.mockResolvedValue(true);
      const { context, request } = contextWith(`Bearer ${tokens.sign(accessClaims)}`);

      const thrown = await guard.canActivate(context).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(UnauthorizedException);
      expect((thrown as UnauthorizedException).getResponse()).toMatchObject({
        i18nKey: 'auth.permissionsChanged',
        reason: 'permissionsChanged',
      });
      expect(request.user).toBeUndefined();
    });

    it('does not ask about permissions for a session that is already gone', async () => {
      sessions.read.mockResolvedValue(null);
      const { context } = contextWith(`Bearer ${tokens.sign(accessClaims)}`);

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        response: { reason: 'sessionRevoked' },
      });
      expect(permissions.isStale).not.toHaveBeenCalled();
    });

    it('rejects an expired token before touching the session store', async () => {
      const { context } = contextWith(`Bearer ${tokens.sign(accessClaims, -1)}`);

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        response: { reason: 'tokenExpired' },
      });
      expect(sessions.read).not.toHaveBeenCalled();
    });

    it('rejects a token signed with another secret', async () => {
      const other = new TokenService({
        get: (key: string, fallback?: unknown) =>
          key === 'JWT_ACCESS_SECRET'
            ? 'someone-elses-secret'
            : key in stubbed
              ? stubbed[key]
              : fallback,
      } as unknown as ConfigService);
      const { context } = contextWith(`Bearer ${other.sign(accessClaims)}`);

      await expect(guard.canActivate(context)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a token with a truncated signature without a RangeError', async () => {
      const [header, payload, signature] = tokens.sign(accessClaims).split('.');
      const { context } = contextWith(
        `Bearer ${header}.${payload}.${signature.slice(0, 8)}`,
      );

      await expect(guard.canActivate(context)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(guard.canActivate(context)).rejects.not.toThrow(RangeError);
    });
  });

  // The critical case: single-purpose tokens are signed with the same secret
  // as access tokens, so the signature check alone cannot tell them apart.
  // Only `purpose` can — see the equivalent check in
  // guards/no-active-session.guard.ts.
  describe('single-purpose tokens must not pass as access tokens', () => {
    it.each([
      ['an OTP token', () => tokens.signOtpToken('user-1')],
      ['a reset token', () => tokens.signResetToken('+989120000000', 'user-1')],
    ])('rejects %s', async (_label, mint) => {
      const { context, request } = contextWith(`Bearer ${mint()}`);

      await expect(guard.canActivate(context)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(request.user).toBeUndefined();
    });
  });
});

/**
 * ADR-0032, half one. The scope of an authenticated call is the one stamped on
 * its session, not the one re-derived from the request — which is what lets a
 * Mini App session minted under `bot:telegram:<chat>` still see that chat's
 * group when it calls `/auth/accounts` with only a `device_id` cookie.
 */
describe('AuthGuard — the switch scope of an authenticated call', () => {
  let tokens: TokenService;
  let sessions: { read: Mock };
  let permissions: { isStale: Mock };
  let guard: AuthGuard;

  beforeEach(() => {
    tokens = new TokenService(configStub);
    sessions = {
      read: vi.fn().mockResolvedValue({ userId: 'user-1', scopeKey: null }),
    };
    permissions = { isStale: vi.fn().mockResolvedValue(false) };
    guard = new AuthGuard(
      tokens,
      sessions as unknown as SessionStore,
      permissions as unknown as PermissionStateStore,
    );
  });

  it("replaces the request's scope with the session's own", async () => {
    sessions.read.mockResolvedValue({
      userId: 'user-1',
      scopeKey: 'bot:tenant-1:telegram:5501',
    });
    const { context, request } = contextWith(
      `Bearer ${tokens.sign(accessClaims)}`,
      'device:aaaa-bbbb',
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.switchScope).toBe('bot:tenant-1:telegram:5501');
  });

  it('leaves the request alone for a session minted before this shipped', async () => {
    // No `scopeKey` on the marker — the behaviour that predates ADR-0032, so
    // an old session keeps working without a keyspace flush.
    sessions.read.mockResolvedValue({ userId: 'user-1', scopeKey: null });
    const { context, request } = contextWith(
      `Bearer ${tokens.sign(accessClaims)}`,
      'device:aaaa-bbbb',
    );

    await guard.canActivate(context);

    expect(request.switchScope).toBe('device:aaaa-bbbb');
  });

  it('does not let a swapped cookie move an authenticated caller', async () => {
    sessions.read.mockResolvedValue({
      userId: 'user-1',
      scopeKey: 'device:the-one-it-was-minted-under',
    });
    const { context, request } = contextWith(
      `Bearer ${tokens.sign(accessClaims)}`,
      'device:a-cookie-someone-pasted-in',
    );

    await guard.canActivate(context);

    expect(request.switchScope).toBe('device:the-one-it-was-minted-under');
  });
});

/**
 * BAN-1-c (ADR-0133 decision 4). auth-service is not behind the gate, so its
 * guard is the gate for its own routes: a restricted token reaches only a
 * handler marked `@AllowRestricted()` — `me`, the switcher — and every other
 * one answers `403 auth.accountRestricted`. Unmarked is refused, so a route
 * someone forgot to think about fails closed.
 */
describe('AuthGuard — a restricted token (ADR-0133)', () => {
  class Marked {
    @AllowRestricted()
    open() {}
    shut() {}
  }
  @AllowRestricted()
  class MarkedClass {
    any() {}
  }

  const tokens = new TokenService(configStub);
  const guard = new AuthGuard(
    tokens,
    { read: vi.fn().mockResolvedValue({ userId: 'user-1', scopeKey: null }) } as unknown as SessionStore,
    { isStale: vi.fn().mockResolvedValue(false) } as unknown as PermissionStateStore,
    new Reflector(),
  );
  const at = (claims: object, cls: new () => object, handler: string) => {
    const { context } = contextWith(`Bearer ${tokens.sign({ ...accessClaims, ...claims })}`);
    Object.assign(context, {
      getClass: () => cls,
      getHandler: () => (cls.prototype as Record<string, unknown>)[handler],
    });
    return guard.canActivate(context);
  };

  it('admits it on a marked handler and in a marked controller', async () => {
    await expect(at({ restricted: true, permissions: [] }, Marked, 'open')).resolves.toBe(true);
    await expect(at({ restricted: true, permissions: [] }, MarkedClass, 'any')).resolves.toBe(true);
  });

  it('refuses it anywhere else with accountRestricted', async () => {
    const refusal = at({ restricted: true, permissions: [] }, Marked, 'shut');
    await expect(refusal).rejects.toThrow(ForbiddenException);
    await expect(refusal).rejects.toMatchObject({
      response: { i18nKey: 'auth.accountRestricted', reason: 'accountRestricted' },
    });
  });

  it('leaves an unrestricted token alone everywhere', async () => {
    await expect(at({}, Marked, 'shut')).resolves.toBe(true);
  });
});

/**
 * AC-1-g (catalog §3.6 layer 4, ADR-0136). auth-service is not behind the
 * gate, so its guard holds the impersonation list for its own routes: an
 * impersonated token reaches only a listed `/api/auth` route, and the password,
 * the account switcher, the sessions and every route nobody listed answer
 * `403 impersonation.blockedAction`.
 */
describe('AuthGuard — an impersonated token (AC-1-g)', () => {
  const tokens = new TokenService(configStub);
  const guard = new AuthGuard(
    tokens,
    { read: vi.fn().mockResolvedValue({ userId: 'user-1', scopeKey: null }) } as unknown as SessionStore,
    { isStale: vi.fn().mockResolvedValue(false) } as unknown as PermissionStateStore,
    new Reflector(),
  );
  const at = (claims: object, method: string, originalUrl: string) => {
    const { context, request } = contextWith(`Bearer ${tokens.sign({ ...accessClaims, ...claims })}`);
    Object.assign(request, { method, originalUrl });
    return guard.canActivate(context);
  };
  const impersonated = { isImpersonated: true, impersonatedBy: 'support-7' };

  it('admits it on a listed route', async () => {
    await expect(at(impersonated, 'GET', '/api/auth/me')).resolves.toBe(true);
    await expect(at(impersonated, 'POST', '/api/auth/impersonate/end')).resolves.toBe(true);
  });

  it.each([
    ['POST', '/api/auth/me/password'],
    ['POST', '/api/auth/accounts/switch'],
    ['GET', '/api/auth/sessions'],
    ['GET', '/api/auth/roles'],
  ])('refuses %s %s with impersonationBlocked', async (method, url) => {
    const refusal = at(impersonated, method, url);
    await expect(refusal).rejects.toThrow(ForbiddenException);
    await expect(refusal).rejects.toMatchObject({
      response: { i18nKey: 'impersonation.blockedAction', reason: 'impersonationBlocked' },
    });
  });

  it('leaves an own token alone everywhere', async () => {
    await expect(at({}, 'POST', '/api/auth/me/password')).resolves.toBe(true);
  });
});
