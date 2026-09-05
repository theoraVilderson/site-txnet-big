import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from './auth.guard';
import { SessionStore } from './session/session.store';
import { AuthClaims, TokenService } from './token.service';

const ACCESS_SECRET = 'unit-test-access-secret';

const configStub = {
  get: (key: string, fallback?: unknown) =>
    key === 'JWT_ACCESS_SECRET' ? ACCESS_SECRET : fallback,
} as unknown as ConfigService;

const accessClaims: Omit<AuthClaims, 'iat' | 'exp'> = {
  sub: 'user-1',
  tenantId: 'tenant-1',
  roleId: 'role-1',
  permissions: ['user.read'],
  sessionId: 'session-1',
};

function contextWith(header?: string) {
  const request: { get: (name: string) => string | undefined; user?: unknown } =
    {
      get: (name: string) =>
        name.toLowerCase() === 'authorization' ? header : undefined,
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
  let sessions: { isActive: jest.Mock };
  let guard: AuthGuard;

  beforeEach(() => {
    tokens = new TokenService(configStub);
    // Say yes to every session id, so the assertions below turn on the token
    // itself and not on an incidental Redis miss.
    sessions = { isActive: jest.fn().mockResolvedValue(true) };
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
      expect(sessions.isActive).toHaveBeenCalledWith('session-1');
    });

    it('rejects a token whose session has been revoked', async () => {
      sessions.isActive.mockResolvedValue(false);
      const { context } = contextWith(`Bearer ${tokens.sign(accessClaims)}`);

      await expect(guard.canActivate(context)).rejects.toThrow(
        'session revoked',
      );
    });

    it('rejects an expired token before touching the session store', async () => {
      const { context } = contextWith(`Bearer ${tokens.sign(accessClaims, -1)}`);

      await expect(guard.canActivate(context)).rejects.toThrow('token expired');
      expect(sessions.isActive).not.toHaveBeenCalled();
    });

    it('rejects a token signed with another secret', async () => {
      const other = new TokenService({
        get: (key: string, fallback?: unknown) =>
          key === 'JWT_ACCESS_SECRET' ? 'someone-elses-secret' : fallback,
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
