/**
 * The `/admin/workers` routes on the wire (F-031-b).
 *
 * What only this level can answer is what the guards and the envelope do
 * *before* any handler runs: an unauthenticated caller and a signed-in user
 * with no `worker.manage` are told apart, both in the sanitized thrown-error
 * shape rather than a stack trace, and the permission is checked ahead of the
 * body — so an admin surface cannot be probed for the shape it accepts by
 * someone who may not reach it.
 *
 * **What this file deliberately does not cover.** The authorised half — a
 * schedule written, a worker switched off, a manual tick published — needs a
 * role carrying `worker.manage` and a `bot_worker` row, and this suite has no
 * fixture for either: workers are registered on boot by `worker-service`, which
 * the e2e app does not run. Those rules are stated one tier down, against the
 * service, in `auth-service/src/app/automation/worker-admin.service.spec.ts`.
 * Asserting them here would mean seeding a permission this suite otherwise
 * never grants, which buys a green test rather than a proof.
 */
import request from 'supertest';
import { createE2eApp, E2eApp } from '../support/app';
import { AuthApi } from '../support/api';
import { signUp } from '../support/fixtures';

describe('auth-api — the worker admin surface', () => {
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

  it('refuses an unauthenticated caller with 401 and the thrown-error envelope', async () => {
    const res = await api.get('/admin/workers');

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(typeof res.body.msg).toBe('string');
    // Sanitized: a correlation id, never the underlying detail.
    expect(res.body).not.toHaveProperty('data');
  });

  it('refuses a signed-in user without worker.manage with 403', async () => {
    const { accessToken } = await signUp(api, e2e.otp);

    const res = await api.get('/admin/workers', { bearer: accessToken });

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  it('checks the permission before the body — a malformed write is still 403', async () => {
    const { accessToken } = await signUp(api, e2e.otp);

    const res = await api.post(
      '/admin/workers/heartbeat/schedules',
      { scheduleType: 'not-a-type' },
      { bearer: accessToken },
    );

    // 403, not 400: a caller who may not reach the route learns nothing about
    // the shape it would have accepted.
    expect(res.status).toBe(403);
  });

  it('answers 401 on the toggle and the manual run too, not only on the list', async () => {
    // Straight through supertest: `AuthApi` has no PATCH, and adding one
    // would edit `support/**`, which every other e2e file boots.
    const toggle = await request(e2e.server)
      .patch('/api/admin/workers/heartbeat')
      .send({ isActive: false });
    const run = await api.post('/admin/workers/heartbeat/run', {});

    expect(toggle.status).toBe(401);
    expect(run.status).toBe(401);
  });
});
