import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from './auth.guard';
import { SessionStore } from './session/session.store';
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
  let sessions: { read: jest.Mock };
  let guard: AuthGuard;

  beforeEach(() => {
    tokens = new TokenService(configStub);
    // Say yes to every session id, so the assertions below turn on the token
    // itself and not on an incidental Redis miss.
    sessions = {
      read: jest.fn().mockResolvedValue({ userId: 'user-1', scopeKey: null }),
    };
    guard = new AuthGuard(tokens, sessions as unknown as SessionStore);
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

      await expect(guard.canActivate(context)).rejects.toThrow(
        'session revoked',
      );
    });

    it('rejects an expired token before touching the session store', async () => {
      const { context } = contextWith(`Bearer ${tokens.sign(accessClaims, -1)}`);

      await expect(guard.canActivate(context)).rejects.toThrow('token expired');
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
  let sessions: { read: jest.Mock };
  let guard: AuthGuard;

  beforeEach(() => {
    tokens = new TokenService(configStub);
    sessions = {
      read: jest.fn().mockResolvedValue({ userId: 'user-1', scopeKey: null }),
    };
    guard = new AuthGuard(tokens, sessions as unknown as SessionStore);
  });

  it("replaces the request's scope with the session's own", async () => {
    sessions.read.mockResolvedValue({
      userId: 'user-1',
      scopeKey: 'bot:telegram:5501',
    });
    const { context, request } = contextWith(
      `Bearer ${tokens.sign(accessClaims)}`,
      'device:aaaa-bbbb',
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.switchScope).toBe('bot:telegram:5501');
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
