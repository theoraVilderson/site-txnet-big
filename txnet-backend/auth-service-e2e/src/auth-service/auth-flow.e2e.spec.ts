/**
 * The signed-out-to-signed-in path, end to end:
 *   register -> OTP -> verify-phone -> login -> refresh -> logout
 *
 * Every assertion here is about what a client can observe: status code,
 * response envelope, the `refresh_token` cookie, and the rows the flow is
 * supposed to have left behind (or, for `register`, not left behind).
 */
import { createE2eApp, E2eApp } from '../support/app';
import { AuthApi, parseSetCookie } from '../support/api';
import { ACCESS_TTL_SEC, REFRESH_COOKIE } from '../support/env';
import { newAccount, signUp } from '../support/fixtures';

describe('auth-api — signup, login, refresh, logout', () => {
  let e2e: E2eApp;
  let api: AuthApi;

  beforeAll(async () => {
    e2e = await createE2eApp();
  });

  afterAll(async () => {
    await e2e.close();
  });

  beforeEach(async () => {
    await e2e.reset();
    api = new AuthApi(e2e.server);
  });

  describe('POST /auth/register', () => {
    it('accepts the account, sends a code, and creates no user row yet', async () => {
      const account = newAccount();

      const res = await api.register(account);

      // 202, not 201: since v13 the code is queued rather than sent, and no
      // row is created here in any case (identity/invariants.md #11).
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        ok: true,
        msg: 'register.success',
        data: {
          phoneNumber: account.phoneNumber,
          requiresPhoneVerification: true,
          // The status handle (F-067-a) and the realtime channel that carries
          // the same answer without being asked (F-067-j). All three are
          // minted per request, before anything is known about the phone
          // number, so their presence says nothing about the account.
          deliveryId: expect.stringMatching(/^[0-9a-f]{32}$/),
          channel: expect.stringMatching(/^otp:[0-9a-f]{32}$/),
          channelToken: expect.stringMatching(/^[0-9a-f]{32}$/),
        },
      });

      // The three are distinct values. Reusing one for two purposes would put
      // the capability that reads the status into a channel name, which
      // reaches Redis pub/sub, gateway logs and metrics (F-067-j).
      const handles = res.body.data;
      expect(
        new Set([
          handles.deliveryId,
          handles.channel.slice('otp:'.length),
          handles.channelToken,
        ]).size,
      ).toBe(3);

      // identity/invariants.md #11: the row appears at verify-phone, not here.
      await expect(
        e2e.db((db) =>
          db.user.count({ where: { phoneNumber: account.phoneNumber } }),
        ),
      ).resolves.toBe(0);

      expect(e2e.otp.all()).toEqual([
        {
          purpose: 'register_phone_verify',
          channel: 'sms',
          phoneNumber: account.phoneNumber,
          code: expect.stringMatching(/^\d{6}$/),
        },
      ]);
    });

    it('rejects a phone number that already has an account', async () => {
      const { account } = await signUp(api, e2e.otp);

      const res = await api.register(newAccount({ phoneNumber: account.phoneNumber }));

      // 202 with `ok: false` — a business rejection keeps the route's own
      // status, and `register`'s is 202 since v13; see contract.md
      // "Response envelopes".
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ ok: false, msg: 'register.duplicateUser' });
    });
  });

  describe('POST /auth/register/verify-phone', () => {
    it('creates the user and hands out the first session', async () => {
      const account = newAccount();
      await api.register(account);
      const code = e2e.otp.latest(account.phoneNumber, 'register_phone_verify');

      const res = await api.verifyPhone({
        phoneNumber: account.phoneNumber,
        otpCode: code,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        msg: 'register.phoneVerified',
        data: {
          userId: expect.any(String),
          phoneVerified: true,
          accessToken: expect.any(String),
          expiresIn: ACCESS_TTL_SEC,
        },
      });
      // The refresh token is a cookie, never a body field.
      expect(res.body.data).not.toHaveProperty('refreshToken');
      expect(api.refreshCookie).toEqual(expect.any(String));

      // `findFirst`, not `findUnique`: a phone number is unique **within a
      // tenant** since F-065-b, so it is no longer a unique key on its own.
      const user = await e2e.db((db) =>
        db.user.findFirstOrThrow({
          where: { phoneNumber: account.phoneNumber },
        }),
      );
      expect(user.username).toBe(account.username);
      expect(user.status).toBe('active');
      expect(user.phoneVerifiedAt).toBeInstanceOf(Date);

      await expect(
        e2e.prisma.session.count({ where: { userId: user.id, revokedAt: null } }),
      ).resolves.toBe(1);
    });

    it('refuses a wrong code and keeps the account pending', async () => {
      const account = newAccount();
      await api.register(account);

      const res = await api.verifyPhone({
        phoneNumber: account.phoneNumber,
        otpCode: '000000',
      });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, msg: 'system.badRequest' });
      await expect(
        e2e.db((db) =>
          db.user.count({ where: { phoneNumber: account.phoneNumber } }),
        ),
      ).resolves.toBe(0);
    });

    it('cannot be replayed: the code is consumed by the first use', async () => {
      const account = newAccount();
      await api.register(account);
      const code = e2e.otp.latest(account.phoneNumber, 'register_phone_verify');
      await api.verifyPhone({ phoneNumber: account.phoneNumber, otpCode: code });

      const replay = await api.verifyPhone({
        phoneNumber: account.phoneNumber,
        otpCode: code,
      });

      expect(replay.status).toBe(400);
      expect(replay.body.ok).toBe(false);
      await expect(
        e2e.db((db) =>
          db.user.count({ where: { phoneNumber: account.phoneNumber } }),
        ),
      ).resolves.toBe(1);
    });
  });

  describe('POST /auth/login/password', () => {
    it('signs a verified account in and sets the refresh cookie', async () => {
      const { account } = await signUp(api, e2e.otp);
      api.clearCookies(); // a fresh browser

      const res = await api.login({
        identifier: account.username,
        password: account.password,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        msg: 'auth.loginSuccess',
        data: { accessToken: expect.any(String), expiresIn: ACCESS_TTL_SEC },
      });

      const cookie = parseSetCookie(res.headers['set-cookie'], REFRESH_COOKIE);
      expect(cookie?.value).toEqual(expect.any(String));
      expect(cookie?.attributes).toMatchObject({ httponly: true, path: '/' });
    });

    it('accepts the phone number as the identifier too', async () => {
      const { account } = await signUp(api, e2e.otp);
      api.clearCookies();

      const res = await api.login({
        identifier: account.phoneNumber,
        password: account.password,
      });

      expect(res.body).toMatchObject({ ok: true, msg: 'auth.loginSuccess' });
    });

    it('answers a wrong password and an unknown account identically', async () => {
      const { account } = await signUp(api, e2e.otp);
      api.clearCookies();

      const wrongPassword = await api.login({
        identifier: account.username,
        password: 'Wr0ng!Passw0rd',
      });
      const unknownUser = await api.login({
        identifier: 'nobody_at_all',
        password: 'Wr0ng!Passw0rd',
      });

      expect(wrongPassword.body).toMatchObject({
        ok: false,
        msg: 'auth.invalidCredentials',
      });
      expect(unknownUser.body).toEqual(wrongPassword.body);
      expect(unknownUser.headers['set-cookie']).toBeUndefined();
    });

    it('is refused while a live session is presented (F-0101)', async () => {
      const { accessToken } = await signUp(api, e2e.otp);
      const account = newAccount();

      const res = await api.login(
        { identifier: account.username, password: account.password },
        { bearer: accessToken },
      );

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        ok: false,
        msg: 'auth.alreadyAuthenticated',
        ref: expect.any(String),
      });
    });
  });

  describe('login over a one-time code', () => {
    it('sends a code and exchanges it for a session', async () => {
      const { account } = await signUp(api, e2e.otp);
      api.clearCookies();

      const requested = await api.requestLoginOtp({
        phoneNumber: account.phoneNumber,
      });
      // 202: the code is queued, not sent (v13).
      expect(requested.status).toBe(202);
      expect(requested.body).toEqual({
        ok: true,
        msg: 'auth.otpSent',
        data: {
          accepted: true,
          // Minted per request, before anything is known about the number —
          // which is what keeps them from answering the existence question
          // `{accepted:true}` refuses (F-067-a, F-067-j).
          deliveryId: expect.stringMatching(/^[0-9a-f]{32}$/),
          channel: expect.stringMatching(/^otp:[0-9a-f]{32}$/),
          channelToken: expect.stringMatching(/^[0-9a-f]{32}$/),
        },
      });

      const code = e2e.otp.latest(account.phoneNumber, 'login');
      const verified = await api.verifyLoginOtp({
        phoneNumber: account.phoneNumber,
        otpCode: code,
      });

      expect(verified.status).toBe(200);
      expect(verified.body).toEqual({
        ok: true,
        msg: 'auth.loginSuccess',
        data: { accessToken: expect.any(String), expiresIn: ACCESS_TTL_SEC },
      });
      expect(api.refreshCookie).toEqual(expect.any(String));
    });

    it('says the same thing for a number that has no account, and sends nothing', async () => {
      const stranger = newAccount();

      const res = await api.requestLoginOtp({ phoneNumber: stranger.phoneNumber });

      expect(res.body).toEqual({
        ok: true,
        msg: 'auth.otpSent',
        data: {
          accepted: true,
          // Minted per request, before anything is known about the number —
          // which is what keeps them from answering the existence question
          // `{accepted:true}` refuses (F-067-a, F-067-j).
          deliveryId: expect.stringMatching(/^[0-9a-f]{32}$/),
          channel: expect.stringMatching(/^otp:[0-9a-f]{32}$/),
          channelToken: expect.stringMatching(/^[0-9a-f]{32}$/),
        },
      });
      // The handles above are handed out anyway. Nothing was sent, and the
      // status they address stays `queued` for ever — indistinguishable from
      // a slow provider, which is the whole point.
      expect(e2e.otp.isEmpty()).toBe(true);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates the pair and kills the token it was given', async () => {
      const { refreshToken } = await signUp(api, e2e.otp);

      const res = await api.refresh();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        msg: 'auth.refreshSuccess',
        data: { accessToken: expect.any(String), expiresIn: ACCESS_TTL_SEC },
      });
      expect(api.refreshCookie).not.toBe(refreshToken);

      const replay = await api.refresh({ refreshToken });
      expect(replay.body).toMatchObject({
        ok: false,
        msg: 'auth.invalidRefreshToken',
      });
    });

    it('takes the token from the body when there is no cookie', async () => {
      const { refreshToken } = await signUp(api, e2e.otp);
      api.clearCookies();

      const res = await api.refresh({ refreshToken });

      expect(res.body).toMatchObject({ ok: true, msg: 'auth.refreshSuccess' });
    });

    it('clears a cookie that no longer resolves to a live session (F-0101)', async () => {
      await signUp(api, e2e.otp);
      await api.logout();
      api.setCookie(REFRESH_COOKIE, 'a-token-that-is-long-enough-to-pass-zod');

      const res = await api.refresh();

      expect(res.body).toMatchObject({
        ok: false,
        msg: 'auth.invalidRefreshToken',
      });
      const cleared = parseSetCookie(res.headers['set-cookie'], REFRESH_COOKIE);
      expect(cleared?.value).toBe('');
      expect(api.refreshCookie).toBeUndefined();
    });

    it('answers "no token" when nothing is presented', async () => {
      const res = await api.refresh();

      expect(res.body).toMatchObject({
        ok: false,
        msg: 'auth.refreshTokenRequired',
      });
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the session, clears the cookie, and cannot be undone', async () => {
      const { userId, refreshToken } = await signUp(api, e2e.otp);

      const res = await api.logout();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        msg: 'auth.logoutSuccess',
        data: { success: true },
      });
      const cleared = parseSetCookie(res.headers['set-cookie'], REFRESH_COOKIE);
      expect(cleared?.value).toBe('');
      expect(api.refreshCookie).toBeUndefined();

      const session = await e2e.prisma.session.findFirstOrThrow({
        where: { userId },
      });
      expect(session.revokedAt).toBeInstanceOf(Date);
      expect(session.revokedReason).toBe('user_logout');

      const afterwards = await api.refresh({ refreshToken });
      expect(afterwards.body).toMatchObject({
        ok: false,
        msg: 'auth.invalidRefreshToken',
      });
    });

    it('succeeds for a caller who has no session at all', async () => {
      const res = await api.logout();

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, data: { success: true } });
    });
  });
});
