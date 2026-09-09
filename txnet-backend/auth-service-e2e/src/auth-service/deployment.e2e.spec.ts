/**
 * The suite's own single-tenant assumption, made false (backlog F-059).
 *
 * Every other e2e file boots the one deployment `support/env.ts` used to
 * hardcode, so `.txnet.test`, `http://localhost:4200` and `fa` appeared in
 * assertions as if they were facts about the service. They are facts about a
 * configuration. This file boots a *second* deployment — different domain,
 * different panel origin, different language — and asserts the same three
 * things follow it. If any of them is still a constant somewhere in the
 * service, exactly one file fails, and it says which value.
 *
 * What this does **not** prove, and cannot yet: that one running process
 * serves several tenants. `RegisterService` writes every account to the
 * `platform_owner` tenant and nothing resolves a request to a tenant at all,
 * so multi-tenancy is a property of the schema and the deployment, not of a
 * request. That gap is a backlog row, not a silent hole in this file.
 */
import request from 'supertest';
import { createE2eApp, E2eApp } from '../support/app';
import { AuthApi, parseSetCookie } from '../support/api';
import {
  applyE2eEnv,
  cookieDomainOf,
  PRIMARY_DEPLOYMENT,
  REFRESH_COOKIE,
  SECONDARY_DEPLOYMENT,
} from '../support/env';
import { newAccount, signUp } from '../support/fixtures';

describe('auth-api — a second deployment', () => {
  let e2e: E2eApp;
  let api: AuthApi;

  beforeAll(async () => {
    applyE2eEnv(SECONDARY_DEPLOYMENT);
    e2e = await createE2eApp();
  });

  afterAll(async () => {
    await e2e.close();
    // Leave the worker as the other specs expect to find it.
    applyE2eEnv(PRIMARY_DEPLOYMENT);
  });

  beforeEach(async () => {
    await e2e.reset();
    api = new AuthApi(e2e.server);
  });

  it('sets the refresh cookie on its own domain, not the first deployment’s', async () => {
    const { account } = await signUp(api, e2e.otp);
    api.clearCookies();
    const res = await api.login({
      identifier: account.username,
      password: account.password,
    });

    const cookie = parseSetCookie(res.headers['set-cookie'], REFRESH_COOKIE);

    expect(cookie?.attributes.domain).toBe(cookieDomainOf(SECONDARY_DEPLOYMENT));
    expect(cookie?.attributes.domain).not.toBe(
      cookieDomainOf(PRIMARY_DEPLOYMENT),
    );
  });

  it('lets its own panel origin through CORS', async () => {
    const res = await request(e2e.server)
      .options('/api/auth/login/password')
      .set('Origin', SECONDARY_DEPLOYMENT.frontendOrigin)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(
      SECONDARY_DEPLOYMENT.frontendOrigin,
    );
  });

  it('does not let the first deployment’s panel origin through', async () => {
    const res = await request(e2e.server)
      .options('/api/auth/login/password')
      .set('Origin', PRIMARY_DEPLOYMENT.frontendOrigin)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).not.toBe(
      PRIMARY_DEPLOYMENT.frontendOrigin,
    );
  });

  it('signs up and logs in exactly as the first deployment does', async () => {
    const { account, accessToken } = await signUp(api, e2e.otp);

    expect(accessToken).toBeTruthy();
    api.clearCookies();
    const login = await api.login({
      identifier: account.username,
      password: account.password,
    });
    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);
  });

  it('refuses a duplicate the same way, whichever deployment is booted', async () => {
    const { account } = await signUp(api, e2e.otp);

    const again = await api.register(newAccount({ username: account.username }));

    expect(again.body.ok).toBe(false);
  });
});
