import { OtpChannel, OtpPurpose } from '@prisma/client';
import { AuthService } from './auth.service';
import { normalizePhone } from '../common/validation/phone.schema';

/**
 * The canonical stored form is whatever `phone.schema` says it is (E.164 —
 * ADR-0018), never a literal re-typed here: the lock bucket must follow the
 * lookup automatically, which is the invariant these cases exist for.
 */
const CANONICAL_PHONE = normalizePhone('09123456789');

jest.mock('argon2', () => ({
  argon2id: 2,
  verify: jest.fn(),
  hash: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const argon2 = require('argon2') as {
  verify: jest.Mock;
  hash: jest.Mock;
};

/**
 * The login path is the platform's front door, so the things tested here are
 * the ones whose failure is silent: an answer that differs between "no such
 * account" and "wrong password" (identity/invariants.md — the response must be
 * one shape), the lockout that stops credential stuffing, the `purpose` claim
 * that stops an OTP token being spent as a reset token, and the total session
 * revocation after a password reset.
 *
 * The service is built by hand rather than through a Nest TestingModule: every
 * collaborator here is a boundary (Prisma, Redis-backed rate limiter, OTP
 * delivery), and stubbing them directly keeps each test's setup readable —
 * same style as bot-link.service.spec.ts.
 */

const LOCK_THRESHOLD = 10;
const LOCK_WINDOW_SEC = 900;

type Harness = ReturnType<typeof harness>;

function harness() {
  const prisma = {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn((args: unknown) => ({ __op: 'user.update', args })),
    },
    session: {
      findUnique: jest.fn(),
      updateMany: jest.fn((args: unknown) => ({
        __op: 'session.updateMany',
        args,
      })),
    },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  };
  const rateLimiter = {
    hit: jest.fn().mockResolvedValue({ allowed: true, current: 1, limit: 10 }),
    reset: jest.fn().mockResolvedValue(undefined),
  };
  const tokens = {
    signAccessToken: jest.fn().mockReturnValue('access-token'),
    signOtpToken: jest.fn().mockReturnValue('otp-token'),
    signResetToken: jest.fn().mockReturnValue('reset-token'),
    refreshHash: jest.fn((t: string) => `hash(${t})`),
    verify: jest.fn(),
  };
  const config = {
    get: jest.fn((_key: string, fallback?: unknown) => fallback),
  };
  const otp = {
    issueOtp: jest.fn().mockResolvedValue(undefined),
    verifyOtp: jest.fn().mockResolvedValue(true),
  };
  const channels = {
    describe: jest.fn().mockReturnValue([]),
    requiresLink: jest.fn().mockReturnValue(false),
    assertUsable: jest.fn(),
    isAvailable: jest.fn().mockReturnValue(true),
    defaultChannel: jest.fn().mockReturnValue(OtpChannel.sms),
  };
  const botLinks = {
    hasVerifiedLink: jest.fn().mockResolvedValue(true),
    startLink: jest.fn(),
  };
  const sessionService = {
    createSession: jest.fn().mockResolvedValue({
      session: { id: 'session-new' },
      refreshToken: 'refresh-new',
    }),
    revokeSession: jest.fn().mockResolvedValue(undefined),
  };
  const sessions = { dropAllForUser: jest.fn().mockResolvedValue(undefined) };

  const service = new AuthService(
    prisma as never,
    rateLimiter as never,
    tokens as never,
    config as never,
    otp as never,
    channels as never,
    botLinks as never,
    sessionService as never,
    sessions as never,
  );

  return {
    service,
    prisma,
    rateLimiter,
    tokens,
    config,
    otp,
    channels,
    botLinks,
    sessionService,
    sessions,
  };
}

const activeUser = (over: Record<string, unknown> = {}) => ({
  id: 'user-1',
  tenantId: 'tenant-1',
  roleId: 'role-1',
  username: 'behnam',
  fullName: 'Behnam T',
  phoneNumber: '09123456789',
  passwordHash: 'argon2-hash',
  status: 'active',
  deletedAt: null,
  phoneVerifiedAt: new Date('2026-01-01'),
  twoFactorEnabled: false,
  preferredOtpChannel: null,
  role: { rolePermissions: [] },
  ...over,
});

const login = (h: Harness, password = 'Correct!Passw0rd') =>
  h.service.loginWithPassword(
    { identifier: 'behnam', password } as never,
    '1.2.3.4',
    'jest-ua',
    'fa',
  );

describe('AuthService.loginWithPassword — one answer for every bad credential', () => {
  let h: Harness;

  beforeEach(() => {
    jest.clearAllMocks();
    h = harness();
  });

  const INVALID = { ok: false, msg: 'auth.invalidCredentials', error: null };

  it('answers the same for an unknown account as for a wrong password', async () => {
    h.prisma.user.findFirst.mockResolvedValue(null);
    const unknown = await login(h);

    h.prisma.user.findFirst.mockResolvedValue(activeUser());
    argon2.verify.mockResolvedValue(false);
    const wrongPassword = await login(h);

    expect(unknown).toEqual(INVALID);
    expect(wrongPassword).toEqual(INVALID);
    expect(unknown).toEqual(wrongPassword);
  });

  it('answers the same for a soft-deleted and for a suspended account', async () => {
    h.prisma.user.findFirst.mockResolvedValue(
      activeUser({ deletedAt: new Date('2026-02-02') }),
    );
    expect(await login(h)).toEqual(INVALID);

    h.prisma.user.findFirst.mockResolvedValue(
      activeUser({ status: 'suspended' }),
    );
    expect(await login(h)).toEqual(INVALID);
  });

  it('never reaches the password check for an account that does not exist', async () => {
    h.prisma.user.findFirst.mockResolvedValue(null);
    await login(h);
    expect(argon2.verify).not.toHaveBeenCalled();
  });

  it('issues no session and no token when the password is wrong', async () => {
    h.prisma.user.findFirst.mockResolvedValue(activeUser());
    argon2.verify.mockResolvedValue(false);

    await login(h);

    expect(h.sessionService.createSession).not.toHaveBeenCalled();
    expect(h.tokens.signAccessToken).not.toHaveBeenCalled();
    expect(h.rateLimiter.reset).not.toHaveBeenCalled();
  });

  /**
   * An unverified account has its own answer, but only once the password has
   * been proven. To anyone who does not already hold the credentials it is
   * indistinguishable from a nonexistent account — otherwise the key is an
   * account-existence oracle that undoes every assertion above it.
   */
  it('hides an unverified account behind invalidCredentials on a wrong password', async () => {
    h.prisma.user.findFirst.mockResolvedValue(
      activeUser({ phoneVerifiedAt: null }),
    );
    argon2.verify.mockResolvedValue(false);

    expect(await login(h)).toEqual(INVALID);
  });

  it('asks an unverified account to verify only once the password is right', async () => {
    h.prisma.user.findFirst.mockResolvedValue(
      activeUser({ phoneVerifiedAt: null }),
    );
    argon2.verify.mockResolvedValue(true);

    expect(await login(h)).toEqual({
      ok: false,
      msg: 'auth.phoneVerificationRequired',
      error: null,
    });
    // Invariant #6: the login still does not complete.
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
    expect(h.tokens.signAccessToken).not.toHaveBeenCalled();
    expect(h.otp.issueOtp).not.toHaveBeenCalled();
  });
});

describe('AuthService.loginWithPassword — lockout', () => {
  let h: Harness;

  beforeEach(() => {
    jest.clearAllMocks();
    h = harness();
    h.prisma.user.findFirst.mockResolvedValue(activeUser());
  });

  it(`counts failures per identifier against ${LOCK_THRESHOLD} in ${LOCK_WINDOW_SEC}s`, async () => {
    argon2.verify.mockResolvedValue(false);
    await login(h);

    expect(h.rateLimiter.hit).toHaveBeenCalledWith(
      'login-failures:behnam',
      LOCK_THRESHOLD,
      LOCK_WINDOW_SEC,
    );
  });

  it(`locks once the window's ${LOCK_THRESHOLD} attempts are used up`, async () => {
    argon2.verify.mockResolvedValue(false);
    let current = 0;
    h.rateLimiter.hit.mockImplementation(async () => {
      current += 1;
      return { allowed: current <= LOCK_THRESHOLD, current, limit: LOCK_THRESHOLD };
    });

    for (let i = 0; i < LOCK_THRESHOLD; i++) {
      expect(await login(h)).toEqual({
        ok: false,
        msg: 'auth.invalidCredentials',
        error: null,
      });
    }

    expect(await login(h)).toEqual({
      ok: false,
      msg: 'auth.temporarilyLocked',
      error: null,
    });
  });

  /**
   * The lookup normalizes a phone number, so the counter must too: one account
   * has to mean one lock, or the ten attempts are simply repeated under each
   * spelling of the same number.
   */
  it.each([
    ['09123456789'],
    ['+989123456789'],
    ['00989123456789'],
  ])('counts %s against the same bucket as every other spelling', async (
    identifier,
  ) => {
    argon2.verify.mockResolvedValue(false);

    await h.service.loginWithPassword(
      { identifier, password: 'Wrong!Passw0rd' } as never,
      '1.2.3.4',
      'jest-ua',
      'fa',
    );

    expect(h.rateLimiter.hit).toHaveBeenCalledWith(
      `login-failures:${CANONICAL_PHONE}`,
      LOCK_THRESHOLD,
      LOCK_WINDOW_SEC,
    );
  });

  it('clears that same normalized bucket on success', async () => {
    argon2.verify.mockResolvedValue(true);

    await h.service.loginWithPassword(
      { identifier: '+989123456789', password: 'Correct!Passw0rd' } as never,
      '1.2.3.4',
      'jest-ua',
      'fa',
    );

    expect(h.rateLimiter.reset).toHaveBeenCalledWith(
      `login-failures:${CANONICAL_PHONE}`,
    );
  });

  it('leaves a username alone rather than running it through phone normalization', async () => {
    argon2.verify.mockResolvedValue(false);
    await login(h);
    expect(h.rateLimiter.hit.mock.calls[0][0]).toBe('login-failures:behnam');
  });

  it('does not check the password at all once locked', async () => {
    h.rateLimiter.hit.mockResolvedValue({
      allowed: false,
      current: 11,
      limit: LOCK_THRESHOLD,
    });

    await login(h);

    expect(argon2.verify).not.toHaveBeenCalled();
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
  });

  it('clears the counter on a correct password', async () => {
    argon2.verify.mockResolvedValue(true);

    const res = await login(h);

    expect(h.rateLimiter.reset).toHaveBeenCalledWith('login-failures:behnam');
    expect(res).toMatchObject({ ok: true, msg: 'auth.loginSuccess' });
  });
});

describe('AuthService.loginWithPassword — two-factor', () => {
  let h: Harness;

  beforeEach(() => {
    jest.clearAllMocks();
    h = harness();
    argon2.verify.mockResolvedValue(true);
  });

  it('stops at an OTP token instead of a session when 2FA is on', async () => {
    h.prisma.user.findFirst.mockResolvedValue(
      activeUser({ twoFactorEnabled: true }),
    );

    const res = await login(h);

    expect(res).toEqual({
      ok: true,
      msg: 'auth.otpSent',
      data: { requiresOtp: true, otpToken: 'otp-token' },
    });
    expect(h.otp.issueOtp).toHaveBeenCalledWith(
      '09123456789',
      OtpPurpose.login,
      OtpChannel.sms,
      '1.2.3.4',
      'fa',
    );
    expect(h.tokens.signOtpToken).toHaveBeenCalledWith('user-1');
    // The half-finished login must not mint anything usable.
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
    expect(h.tokens.signAccessToken).not.toHaveBeenCalled();
  });

  it('honours a saved channel preference that is still available', async () => {
    h.prisma.user.findFirst.mockResolvedValue(
      activeUser({
        twoFactorEnabled: true,
        preferredOtpChannel: OtpChannel.telegram,
      }),
    );
    h.channels.isAvailable.mockReturnValue(true);

    await login(h);

    expect(h.otp.issueOtp).toHaveBeenCalledWith(
      '09123456789',
      OtpPurpose.login,
      OtpChannel.telegram,
      '1.2.3.4',
      'fa',
    );
  });

  it('falls back to the default channel when the saved preference is switched off', async () => {
    h.prisma.user.findFirst.mockResolvedValue(
      activeUser({
        twoFactorEnabled: true,
        preferredOtpChannel: OtpChannel.telegram,
      }),
    );
    h.channels.isAvailable.mockReturnValue(false);
    h.channels.defaultChannel.mockReturnValue(OtpChannel.bale);

    await login(h);

    expect(h.otp.issueOtp).toHaveBeenCalledWith(
      '09123456789',
      OtpPurpose.login,
      OtpChannel.bale,
      '1.2.3.4',
      'fa',
    );
  });

  it('issues a session directly when 2FA is off', async () => {
    h.prisma.user.findFirst.mockResolvedValue(activeUser());

    const res = await login(h);

    expect(res).toEqual({
      ok: true,
      msg: 'auth.loginSuccess',
      data: {
        accessToken: 'access-token',
        refreshToken: 'refresh-new',
        expiresIn: 900,
      },
    });
    expect(h.otp.issueOtp).not.toHaveBeenCalled();
  });
});

describe('AuthService.verifyLoginOtp — the token purpose is load-bearing', () => {
  let h: Harness;

  beforeEach(() => {
    jest.clearAllMocks();
    h = harness();
  });

  it.each([
    ['password_reset', 'a reset token'],
    ['otp_register', 'a registration token'],
    [undefined, 'a plain access token with no purpose'],
  ])('rejects %s (%s)', async (purpose) => {
    h.tokens.verify.mockReturnValue({ sub: 'user-1', purpose });

    const res = await h.service.verifyLoginOtp(
      { otpToken: 'tok', otpCode: '123456' } as never,
      '1.2.3.4',
      'jest-ua',
    );

    expect(res).toEqual({ ok: false, msg: 'auth.invalidOtpToken', error: null });
    expect(h.otp.verifyOtp).not.toHaveBeenCalled();
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
  });

  it('rejects a token with the right purpose but no subject', async () => {
    h.tokens.verify.mockReturnValue({ purpose: 'otp_login' });

    const res = await h.service.verifyLoginOtp(
      { otpToken: 'tok', otpCode: '123456' } as never,
      '1.2.3.4',
      'jest-ua',
    );

    expect(res).toEqual({ ok: false, msg: 'auth.invalidOtpToken', error: null });
    expect(h.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects an otp_login token whose account is no longer active', async () => {
    h.tokens.verify.mockReturnValue({ sub: 'user-1', purpose: 'otp_login' });
    h.prisma.user.findUnique.mockResolvedValue(
      activeUser({ status: 'suspended' }),
    );

    const res = await h.service.verifyLoginOtp(
      { otpToken: 'tok', otpCode: '123456' } as never,
      '1.2.3.4',
      'jest-ua',
    );

    expect(res).toEqual({ ok: false, msg: 'auth.invalidOtpToken', error: null });
    expect(h.otp.verifyOtp).not.toHaveBeenCalled();
  });

  it('completes the login on a valid otp_login token', async () => {
    h.tokens.verify.mockReturnValue({ sub: 'user-1', purpose: 'otp_login' });
    h.prisma.user.findUnique.mockResolvedValue(activeUser());

    const res = await h.service.verifyLoginOtp(
      { otpToken: 'tok', otpCode: '123456' } as never,
      '1.2.3.4',
      'jest-ua',
    );

    expect(h.otp.verifyOtp).toHaveBeenCalledWith(
      '09123456789',
      OtpPurpose.login,
      '123456',
    );
    expect(res).toMatchObject({ ok: true, msg: 'auth.loginSuccess' });
  });

  it('refuses the tokenless path for an unverified phone', async () => {
    // `findFirst`, not `findUnique`: since F-065-b a phone number is unique
    // only within a tenant, so the lookup is the composite the ambient scope
    // completes (ADR-0023 / ADR-0024).
    h.prisma.user.findFirst.mockResolvedValue(
      activeUser({ phoneVerifiedAt: null }),
    );

    const res = await h.service.verifyLoginOtp(
      { phoneNumber: '09123456789', otpCode: '123456' } as never,
      '1.2.3.4',
      'jest-ua',
    );

    expect(res).toEqual({ ok: false, msg: 'auth.invalidOtp', error: null });
    expect(h.otp.verifyOtp).not.toHaveBeenCalled();
  });
});

describe('AuthService.sessionStatus — the read-only half', () => {
  let h: Harness;

  const liveSession = (over: Record<string, unknown> = {}) => ({
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    h = harness();
  });

  it('answers "signed in" without touching the session', async () => {
    // The reason this method exists. `refresh` rotates, so using it to ask
    // "is this visitor signed in?" revoked the very session being asked about;
    // any caller that then failed to store the replacement cookie left the
    // browser holding a dead token. This must never revoke or mint anything.
    h.prisma.session.findUnique.mockResolvedValue(liveSession());

    const res = await h.service.sessionStatus('refresh-live');

    expect(res).toEqual({
      ok: true,
      msg: 'auth.sessionActive',
      data: { active: true },
    });
    expect(h.sessionService.revokeSession).not.toHaveBeenCalled();
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
  });

  it('looks the session up by the hash, never by the token itself', async () => {
    h.prisma.session.findUnique.mockResolvedValue(liveSession());

    await h.service.sessionStatus('refresh-live');

    expect(h.tokens.refreshHash).toHaveBeenCalledWith('refresh-live');
    expect(h.prisma.session.findUnique.mock.calls[0][0].where).toEqual({
      refreshTokenHash: 'hash(refresh-live)',
    });
  });

  it.each([
    ['unknown', null],
    ['already revoked', { revokedAt: new Date() }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
  ])('reports an %s session inactive', async (_label, over) => {
    h.prisma.session.findUnique.mockResolvedValue(
      over === null ? null : liveSession(over),
    );

    const res = await h.service.sessionStatus('refresh-dead');

    expect(res).toEqual({
      ok: true,
      msg: 'auth.sessionInactive',
      data: { active: false },
    });
    expect(h.sessionService.revokeSession).not.toHaveBeenCalled();
  });

  it('reports no cookie as inactive without asking the database', async () => {
    const res = await h.service.sessionStatus(undefined);

    expect(res).toEqual({
      ok: true,
      msg: 'auth.sessionInactive',
      data: { active: false },
    });
    expect(h.prisma.session.findUnique).not.toHaveBeenCalled();
  });
});

describe('AuthService.refresh — rotation', () => {
  let h: Harness;

  const liveSession = (over: Record<string, unknown> = {}) => ({
    id: 'session-old',
    userId: 'user-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    user: activeUser(),
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    h = harness();
  });

  it('looks the session up by the hash, never by the token itself', async () => {
    h.prisma.session.findUnique.mockResolvedValue(liveSession());

    await h.service.refresh(
      { refreshToken: 'refresh-old' } as never,
      '1.2.3.4',
      'jest-ua',
    );

    expect(h.tokens.refreshHash).toHaveBeenCalledWith('refresh-old');
    expect(h.prisma.session.findUnique.mock.calls[0][0].where).toEqual({
      refreshTokenHash: 'hash(refresh-old)',
    });
  });

  it('revokes the old session before minting the new one', async () => {
    h.prisma.session.findUnique.mockResolvedValue(liveSession());

    const res = await h.service.refresh(
      { refreshToken: 'refresh-old' } as never,
      '1.2.3.4',
      'jest-ua',
    );

    expect(h.sessionService.revokeSession).toHaveBeenCalledWith(
      'session-old',
      'user_logout',
    );
    expect(
      h.sessionService.revokeSession.mock.invocationCallOrder[0],
    ).toBeLessThan(h.sessionService.createSession.mock.invocationCallOrder[0]);
    expect(res).toEqual({
      ok: true,
      msg: 'auth.refreshSuccess',
      data: {
        accessToken: 'access-token',
        refreshToken: 'refresh-new',
        expiresIn: 900,
      },
    });
  });

  /**
   * The trap in ADR-0015. A refresh is the *same* session continuing, so the
   * replacement has to inherit the scope of the row it replaces. Re-deriving
   * it from the request would move a session between scopes whenever anything
   * about the request changed; dropping it would silently detach the account
   * from its own switch group on the first rotation — and the panel refreshes
   * on every page load, so "first rotation" means within seconds.
   */
  it('carries the scope forward onto the replacement session', async () => {
    h.prisma.session.findUnique.mockResolvedValue(
      liveSession({ scopeKey: 'device:browser-a' }),
    );

    await h.service.refresh(
      { refreshToken: 'refresh-old' } as never,
      '1.2.3.4',
      'jest-ua',
    );

    expect(h.sessionService.createSession).toHaveBeenCalledWith(
      'user-1',
      '1.2.3.4',
      'jest-ua',
      { scopeKey: 'device:browser-a' },
    );
  });

  it('carries a null scope forward as null, inventing nothing', async () => {
    h.prisma.session.findUnique.mockResolvedValue(
      liveSession({ scopeKey: null }),
    );

    await h.service.refresh(
      { refreshToken: 'refresh-old' } as never,
      '1.2.3.4',
      'jest-ua',
    );

    expect(h.sessionService.createSession).toHaveBeenCalledWith(
      'user-1',
      '1.2.3.4',
      'jest-ua',
      { scopeKey: null },
    );
  });

  it.each([
    ['unknown', null],
    ['already revoked', { revokedAt: new Date() }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
  ])('refuses to rotate an %s session', async (_label, over) => {
    h.prisma.session.findUnique.mockResolvedValue(
      over === null ? null : liveSession(over),
    );

    const res = await h.service.refresh(
      { refreshToken: 'refresh-old' } as never,
      '1.2.3.4',
      'jest-ua',
    );

    expect(res).toEqual({
      ok: false,
      msg: 'auth.invalidRefreshToken',
      error: null,
    });
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
    expect(h.sessionService.revokeSession).not.toHaveBeenCalled();
  });

  it('rejects a request with no refresh token', async () => {
    const res = await h.service.refresh({} as never, '1.2.3.4', 'jest-ua');
    expect(res).toEqual({
      ok: false,
      msg: 'auth.refreshTokenRequired',
      error: null,
    });
    expect(h.prisma.session.findUnique).not.toHaveBeenCalled();
  });
});

describe('AuthService.resetPassword — every session dies', () => {
  let h: Harness;

  beforeEach(() => {
    jest.clearAllMocks();
    h = harness();
    argon2.hash.mockResolvedValue('new-argon2-hash');
    h.tokens.verify.mockReturnValue({
      sub: 'user-1',
      purpose: 'password_reset',
    });
    h.prisma.user.findUnique.mockResolvedValue(activeUser());
  });

  const reset = (newPassword = 'Fresh!Passw0rd') =>
    h.service.resetPassword(
      { resetToken: 'reset-token', newPassword } as never,
      '1.2.3.4',
      'jest-ua',
    );

  it.each([['otp_login'], ['password_change'], [undefined]])(
    'refuses a token whose purpose is %s',
    async (purpose) => {
      h.tokens.verify.mockReturnValue({ sub: 'user-1', purpose });

      expect(await reset()).toEqual({
        ok: false,
        msg: 'auth.invalidResetToken',
        error: null,
      });
      expect(h.prisma.$transaction).not.toHaveBeenCalled();
      expect(h.sessions.dropAllForUser).not.toHaveBeenCalled();
    },
  );

  it('rewrites the hash and revokes every live session in one transaction', async () => {
    await reset();

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    const ops = h.prisma.$transaction.mock.calls[0][0] as {
      __op: string;
      args: Record<string, never>;
    }[];
    expect(ops.map((o) => o.__op)).toEqual([
      'user.update',
      'session.updateMany',
    ]);
    expect(ops[0].args).toMatchObject({
      where: { id: 'user-1' },
      data: { passwordHash: 'new-argon2-hash' },
    });
    expect(ops[1].args).toMatchObject({
      where: { userId: 'user-1', revokedAt: null },
      data: { revokedReason: 'password_change' },
    });
  });

  it('drops the cached sessions so other devices lose access immediately', async () => {
    await reset();
    expect(h.sessions.dropAllForUser).toHaveBeenCalledWith('user-1');
    expect(
      h.prisma.$transaction.mock.invocationCallOrder[0],
    ).toBeLessThan(h.sessions.dropAllForUser.mock.invocationCallOrder[0]);
  });

  it('signs this device back in on a session minted after the revocation', async () => {
    const res = await reset();

    expect(h.sessionService.createSession).toHaveBeenCalledWith(
      'user-1',
      '1.2.3.4',
      'jest-ua',
      // The reset carries whatever scope the request arrived on (ADR-0015).
      // This caller passes none, so the replacement session belongs to no
      // switch group — which is correct, not a gap: a password reset is not
      // where a group is joined.
      { scopeKey: undefined },
    );
    expect(
      h.sessions.dropAllForUser.mock.invocationCallOrder[0],
    ).toBeLessThan(h.sessionService.createSession.mock.invocationCallOrder[0]);
    expect(res).toMatchObject({
      ok: true,
      msg: 'auth.passwordResetSuccess',
      data: { success: true, accessToken: 'access-token' },
    });
  });

  it('refuses a new password built out of the profile, changing nothing', async () => {
    const res = await reset('behnam!2026A');

    expect(res).toEqual({
      ok: false,
      msg: 'password.containsProfileData',
      error: null,
    });
    expect(argon2.hash).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a valid-looking token for an account that is gone', async () => {
    h.prisma.user.findUnique.mockResolvedValue(null);

    expect(await reset()).toEqual({
      ok: false,
      msg: 'auth.invalidResetToken',
      error: null,
    });
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});
