/**
 * The shapes themselves — what `docs/interfaces/auth-api/contract.md`
 * promises a client, checked against what actually goes over the wire:
 * the two envelopes, the global `api` prefix, the refresh cookie's
 * attributes, CORS, and the status codes.
 *
 * The three envelopes are the point of this file. Two of them mean failure,
 * and only one of those carries an HTTP status that says so — see
 * contract.md's "Response envelopes". A client reads `ok`.
 */
import request from 'supertest';
import { createE2eApp, E2eApp } from '../support/app';
import { AuthApi, parseSetCookie } from '../support/api';
import {
  COOKIE_DOMAIN,
  REFRESH_COOKIE,
  REFRESH_MAX_AGE_SEC,
} from '../support/env';
import { newAccount, signUp } from '../support/fixtures';

describe('auth-api — wire contract', () => {
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

  describe('envelopes', () => {
    it('wraps every success as exactly { ok, msg, data }', async () => {
      const { account } = await signUp(api, e2e.otp);
      api.clearCookies();

      const res = await api.login({
        identifier: account.username,
        password: account.password,
      });

      expect(Object.keys(res.body).sort()).toEqual(['data', 'msg', 'ok']);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.msg).toBe('string');
    });

    it('wraps a thrown error as { ok, msg, ref }, with the key as msg', async () => {
      const res = await api.register(newAccount(), { captcha: null });

      expect(Object.keys(res.body).sort()).toEqual(['msg', 'ok', 'ref']);
      expect(res.body).toMatchObject({
        ok: false,
        msg: 'captcha.required',
        ref: expect.stringMatching(/^[0-9a-f]{10}$/),
      });
    });

    it('adds fieldErrors when the body fails validation', async () => {
      const res = await api.register({ ...newAccount(), phoneNumber: '12345' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        ok: false,
        ref: expect.any(String),
        fieldErrors: [{ path: 'phoneNumber', message: 'phone.invalidFormat' }],
      });
    });

    it('answers a business rejection 200 { ok:false, msg, error } — not a 4xx', async () => {
      // A deliberate `err(...)` is a *result*, not an exception: it does not
      // pass through the exception filter, so it carries `error: null` and no
      // `ref`, and the status stays the route's own. Decided and documented
      // 2026-09-05 — a client reads `ok`, never the status code.
      const res = await api.login({
        identifier: 'no_such_person',
        password: 'Wr0ng!Passw0rd',
      });

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['error', 'msg', 'ok']);
      expect(res.body).toEqual({
        ok: false,
        msg: 'auth.invalidCredentials',
        error: null,
      });
    });

    it('never leaks an internal message: an unknown route is a translated key', async () => {
      const res = await api.post('/auth/does-not-exist', {});

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        ok: false,
        msg: 'system.notFound',
        ref: expect.any(String),
      });
    });
  });

  /**
   * There is no fallback tenant (ADR-0025, F-1210). The claim worth checking
   * over the wire is not the status alone but the *neutrality*: a host the
   * platform does not serve must be indistinguishable from a path that does
   * not exist, or a stranger learns there is a platform here to probe.
   */
  describe('an unknown host', () => {
    const strange = { headers: { Host: 'stranger.example' } };

    it('is a 404 that says exactly what an unknown route says', async () => {
      const unknownHost = await api.post('/auth/captcha/challenge', {}, strange);
      const unknownRoute = await api.post('/auth/does-not-exist', {});

      expect(unknownHost.status).toBe(404);
      expect(unknownHost.body).toMatchObject({
        ok: false,
        msg: 'system.notFound',
        ref: expect.any(String),
      });
      // Same keys, same message — only the correlation id differs.
      expect(Object.keys(unknownHost.body).sort()).toEqual(
        Object.keys(unknownRoute.body).sort(),
      );
      expect(unknownHost.body.msg).toBe(unknownRoute.body.msg);
    });

    it('refuses the route that would otherwise have answered on the seeded host', async () => {
      // The same call without the header is a 200 (see 'paths' below), so the
      // 404 is the host being refused, not the route being missing.
      const res = await api.post('/auth/captcha/challenge', {}, strange);

      expect(res.status).toBe(404);
      expect(res.body.data).toBeUndefined();
    });
  });

  describe('paths', () => {
    it('serves the auth routes under the global /api prefix only', async () => {
      const withPrefix = await request(e2e.server).post('/api/auth/captcha/challenge');
      const withoutPrefix = await request(e2e.server).post('/auth/captcha/challenge');

      expect(withPrefix.status).toBe(200);
      expect(withoutPrefix.status).toBe(404);
    });
  });

  describe('POST /internal/vault/destroy-expired', () => {
    /**
     * The half of this route that a browser can reach, which is the half worth
     * asserting on the wire: **it cannot**. `ServiceOnlyGuard` answers 404, not
     * 401, so the route is indistinguishable from one that does not exist and
     * cannot be found by probing (F-031-c).
     *
     * The authorised half is not covered here on purpose: this harness sets no
     * `SERVICE_AUTH_TOKEN`, and giving it one is a change to
     * `support/**` — the files every e2e spec boots — which makes every run in
     * this project a six-file run. What the route does once it is through the
     * guard is a vault question, and `vault-enforcement.spec.ts` is where the
     * vault's rules are stated.
     */
    it('is 404 to a caller without a service token, like a route that does not exist', async () => {
      const res = await request(e2e.server).post(
        '/api/internal/vault/destroy-expired',
      );

      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('destroyed');
    });
  });

  describe('the refresh cookie', () => {
    it('is httpOnly, domain-wide, lax, and 30 days long', async () => {
      const account = newAccount();
      await api.register(account);
      const res = await api.verifyPhone({
        phoneNumber: account.phoneNumber,
        otpCode: e2e.otp.latest(account.phoneNumber, 'register_phone_verify'),
      });

      const cookie = parseSetCookie(res.headers['set-cookie'], REFRESH_COOKIE);

      expect(cookie).toBeDefined();
      expect(cookie?.attributes).toMatchObject({
        httponly: true,
        path: '/',
        domain: COOKIE_DOMAIN,
        samesite: 'Lax',
        'max-age': String(REFRESH_MAX_AGE_SEC),
      });
      // COOKIE_SECURE=false in this environment; anywhere else it is set.
      expect(cookie?.attributes.secure).toBeUndefined();
    });

    /**
     * F-073. Every route that mints a session writes this cookie, and until
     * this row two of them built the attributes separately —
     * `register.controller.ts` re-declared `domain`, `secure`, `sameSite` and
     * `maxAge` inline instead of calling `refreshCookieOptions()`.
     *
     * The failure that guards against is silent: a cookie written with a
     * different `domain` does not overwrite the other one, so the browser
     * holds two `refresh_token` cookies, sends whichever it likes, and the
     * user lands in a session they did not choose. Nothing is red anywhere.
     *
     * Asserting the two attribute sets are *equal* is the only assertion that
     * catches it — checking each route against a literal would stay green with
     * two copies that happen to agree today and drift tomorrow.
     */
    it('has identical attributes whether it came from register or from login', async () => {
      const account = newAccount();
      await api.register(account);
      const fromRegister = await api.verifyPhone({
        phoneNumber: account.phoneNumber,
        otpCode: e2e.otp.latest(account.phoneNumber, 'register_phone_verify'),
      });
      api.clearCookies();

      const fromLogin = await api.login({
        identifier: account.username,
        password: account.password,
      });

      const registered = parseSetCookie(
        fromRegister.headers['set-cookie'],
        REFRESH_COOKIE,
      );
      const loggedIn = parseSetCookie(
        fromLogin.headers['set-cookie'],
        REFRESH_COOKIE,
      );

      expect(registered?.attributes).toBeDefined();
      expect(loggedIn?.attributes).toEqual(registered?.attributes);
    });

    it('is the only place a refresh token is ever returned', async () => {
      const { account } = await signUp(api, e2e.otp);
      api.clearCookies();

      const login = await api.login({
        identifier: account.username,
        password: account.password,
      });
      const refreshed = await api.refresh();

      for (const res of [login, refreshed]) {
        expect(res.body.data).not.toHaveProperty('refreshToken');
        expect(JSON.stringify(res.body)).not.toContain(api.refreshCookie);
      }
    });
  });

  describe('GET /auth/otp/channels', () => {
    it('describes only what this environment has switched on', async () => {
      const res = await api.otpChannels();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        msg: 'auth.otpChannels',
        data: { channels: [{ channel: 'sms', requiresLink: false }] },
      });
    });
  });

  describe('CORS', () => {
    it('answers a preflight from the configured origin with credentials on', async () => {
      const origin = process.env.FRONTEND_ORIGIN as string;

      const res = await request(e2e.server)
        .options('/api/auth/login/password')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,x-captcha-token');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-headers'].toLowerCase()).toContain(
        'x-captcha-token',
      );
    });

    it('does not hand its origin to a site that was not configured', async () => {
      const res = await request(e2e.server)
        .options('/api/auth/login/password')
        .set('Origin', 'https://attacker.example')
        .set('Access-Control-Request-Method', 'POST');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
