import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NoActiveSessionGuard } from './no-active-session.guard';
import { SessionStore } from '../session/session.store';
import { AuthClaims, TokenService } from '../token.service';
import { fakeExecutionContext } from '../../../test-support/execution-context';

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
  permissions: ['user.read'],
  sessionId: 'session-1',
};

const contextWith = (header?: string) =>
  fakeExecutionContext({ headers: { authorization: header } });

describe('NoActiveSessionGuard', () => {
  let tokens: TokenService;
  let sessions: { isActive: jest.Mock };
  let guard: NoActiveSessionGuard;

  beforeEach(() => {
    tokens = new TokenService(configStub);
    sessions = { isActive: jest.fn().mockResolvedValue(true) };
    guard = new NoActiveSessionGuard(
      tokens,
      sessions as unknown as SessionStore,
    );
  });

  // This guard is the mirror image of AuthGuard: everything AuthGuard rejects
  // means "no live session" here and must be let through, because a caller
  // with no usable token is exactly who is allowed to log in.
  describe('lets an unauthenticated caller through', () => {
    it.each([
      ['no header at all', undefined],
      ['an empty header', ''],
      ['a non-Bearer scheme', 'Basic dXNlcjpwYXNz'],
      ['a lowercase bearer scheme', 'bearer sometoken'],
      ['the word Bearer alone', 'Bearer'],
      ['a garbage token', 'Bearer not-a-jwt'],
    ])('%s', async (_label, header) => {
      const { context } = contextWith(header);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(sessions.isActive).not.toHaveBeenCalled();
    });

    it('an expired access token, without consulting the session store', async () => {
      const { context } = contextWith(`Bearer ${tokens.sign(accessClaims, -1)}`);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(sessions.isActive).not.toHaveBeenCalled();
    });

    it('a token signed with another secret', async () => {
      const other = new TokenService({
        get: (key: string, fallback?: unknown) =>
          key === 'JWT_ACCESS_SECRET'
            ? 'someone-elses-secret'
            : key in stubbed
              ? stubbed[key]
              : fallback,
      } as unknown as ConfigService);
      const { context } = contextWith(`Bearer ${other.sign(accessClaims)}`);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(sessions.isActive).not.toHaveBeenCalled();
    });

    it('a valid token whose session has already been revoked', async () => {
      sessions.isActive.mockResolvedValue(false);
      const { context } = contextWith(`Bearer ${tokens.sign(accessClaims)}`);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(sessions.isActive).toHaveBeenCalledWith('session-1');
    });
  });

  // Single-purpose tokens are signed with the same secret as access tokens, so
  // only `purpose` separates them. Holding one is mid-flow, not signed in —
  // blocking it would strand a user between OTP and password reset.
  describe('single-purpose tokens are not a session', () => {
    it.each([
      ['an OTP token', () => tokens.signOtpToken('user-1')],
      ['a reset token', () => tokens.signResetToken('+989120000000', 'user-1')],
    ])('%s is let through', async (_label, mint) => {
      const { context } = contextWith(`Bearer ${mint()}`);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(sessions.isActive).not.toHaveBeenCalled();
    });
  });

  describe('an already signed-in caller', () => {
    it('is rejected with the auth.alreadyAuthenticated key', async () => {
      const { context } = contextWith(`Bearer ${tokens.sign(accessClaims)}`);

      await expect(guard.canActivate(context)).rejects.toThrow(
        ConflictException,
      );
      await expect(guard.canActivate(context)).rejects.toThrow(
        'auth.alreadyAuthenticated',
      );
      expect(sessions.isActive).toHaveBeenCalledWith('session-1');
    });

    it('answers 409, so the client can tell it apart from bad credentials', async () => {
      const { context } = contextWith(`Bearer ${tokens.sign(accessClaims)}`);

      await expect(guard.canActivate(context)).rejects.toMatchObject({
        status: 409,
      });
    });
  });
});
