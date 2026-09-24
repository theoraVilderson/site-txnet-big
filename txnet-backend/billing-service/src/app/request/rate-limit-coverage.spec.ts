/**
 * Every billing route is rate-limited, per user (F-092-r, D-24).
 *
 * The limit is opt-in per handler, so the way it breaks is silent: a new
 * controller with no `@RateLimit` is simply unlimited, and a bucket built from
 * something two users share — nothing at all, a tenant, a gateway id — is one
 * budget for everyone, which turns a limit into a way for one user to lock the
 * others out. Neither is visible from the route that has it.
 *
 * So this reads every `*.controller.ts` rather than a list someone must keep:
 * a controller added next month is covered the day it is written. `health` is
 * the one exception, and it is outside the gate for the reason `app.module.ts`
 * gives.
 *
 * There is a second, narrower list below. A **public** route has no caller to
 * bucket on, so "one budget for everyone" is not a bug there but the only thing
 * available — and the assertion has to be relaxed rather than deleted, because
 * the route still has to be limited. It names the controller, so putting a
 * gated route on it is a deliberate edit and shows up in a diff as one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RATE_LIMIT_KEY, RateLimitOptions } from '@txnet-backend/shared-core';

import { envSchema } from '../config/env.validation';

/**
 * This file imports every controller for real, which pulls in its whole Nest
 * module graph — far more work than vitest's 5s default allows once `npm test`
 * runs the seven backend projects side by side and the CPU is contended. It
 * was under that default until 2026-09-12 and failed intermittently the day
 * the runner started covering more than one project.
 *
 * The budget is deliberately loose: nothing here is timing-sensitive, so the
 * only thing a tight timeout can catch is the machine being busy.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const APP = join(__dirname, '..');
/**
 * Controllers with no caller to limit at all.
 *
 * `HealthController` is the container's own probe, outside the gate for the
 * reason `app.module.ts` gives. `DepositInternalController` is the
 * service-to-service seam (F-092-k): the only caller is `worker-service`'s
 * tick, proven by `SERVICE_AUTH_TOKEN` and refused as a 404 otherwise, so there
 * is no user, no tenant and nothing forgeable to build a bucket from — and a
 * limit here would throttle the platform's own sweep, which is a way to leave
 * coupon capacity held rather than a way to protect anything.
 *
 * `EntitlementInternalController` is the same seam and the same argument
 * (F-027-y): one hourly tick, `SERVICE_ONLY` or a 404, and throttling it would
 * leave panel seats held by Grants whose clock ran out weeks ago.
 * `GroupFulfilmentController` too (F-027-bl): a minute tick, and throttling it
 * would leave paid Grants `pending` on panels that are ready.
 */
const EXEMPT = new Set(['HealthController', 'DepositInternalController', 'EntitlementInternalController', 'GroupFulfilmentController']);

/**
 * Controllers with no identity to bucket on, and what they count instead.
 *
 * `DepositCallbackController` is a bank redirecting a browser (F-092-j): no
 * session, no token, no `X-User-Id`. Its budget is per **authority** — one
 * payment's worth of settlement attempts — which is asserted in
 * `payment/deposit/deposit-callback.controller.ts`'s own reading and cannot be
 * asserted here, because the fake request this file builds is an identity and
 * nothing else.
 *
 * `DepositWebhookController` is a provider's server (F-104-b, ADR-0051): its
 * budget is per **gateway**, the id in its path.
 *
 * `DepositInChatController` is the bot relaying a messenger's payment
 * (F-104-ab): no session, and its budget is per **sender** — the messenger id
 * of whoever is paying, whichever bot relays them.
 */
const PUBLIC = new Map<string, { subject: string; one: object; another: object }>([
  [
    'DepositCallbackController',
    { subject: 'A0001', one: { query: { Authority: 'A0001', Status: 'OK' } }, another: { query: { Authority: 'A0002', Status: 'OK' } } },
  ],
  [
    'DepositWebhookController',
    { subject: 'g-0001', one: { params: { provider: 'stripe', gatewayId: 'g-0001' } }, another: { params: { provider: 'stripe', gatewayId: 'g-0002' } } },
  ],
  [
    'DepositInChatController',
    { subject: 'telegram:42', one: { body: { platform: 'telegram', senderId: '42' } }, another: { body: { platform: 'telegram', senderId: '43' } } },
  ],
]);

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return controllerFiles(path);
    return e.name.endsWith('.controller.ts') ? [path] : [];
  });
}

type Route = { name: string; options: RateLimitOptions | undefined };

/**
 * Every controller module, imported once. The first import transforms most of
 * the app through SWC — ~4s alone, and past a test's 30s budget when the
 * workspace's `tsc` runs beside it (measured 2026-09-16, twice). So it is a
 * `beforeAll` with its own budget, and the tests share the result.
 */
let loaded: Promise<Route[]> | undefined;
const routes = () => (loaded ??= loadRoutes());
beforeAll(() => routes(), 180_000);

async function loadRoutes(): Promise<Route[]> {
  const found: Route[] = [];
  for (const file of controllerFiles(APP)) {
    const mod = (await import(file)) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      if (typeof value !== 'function' || Reflect.getMetadata(PATH_METADATA, value) === undefined) continue;
      if (EXEMPT.has(value.name)) continue;
      const proto = value.prototype as Record<string, unknown>;
      for (const method of Object.getOwnPropertyNames(proto)) {
        const handler = proto[method];
        if (typeof handler !== 'function' || Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        found.push({
          name: `${value.name}.${method}`,
          options: Reflect.getMetadata(RATE_LIMIT_KEY, handler) as RateLimitOptions | undefined,
        });
      }
    }
  }
  return found;
}

const asUser = (userId: string) => ({ identity: { userId, tenantId: 't', roleId: 'r', sessionId: 's', permissions: [] } });

describe('billing rate limits', () => {
  it('finds the routes it is checking', async () => {
    expect((await routes()).length).toBeGreaterThan(0);
  });

  it('limits every route, from a variable the schema defaults, on a bucket of the caller alone', async () => {
    const defaults = envSchema.parse({
      DATABASE_APP_URL: 'x',
      DATABASE_CROSS_TENANT_URL: 'x',
      REDIS_URL: 'x',
    }) as Record<string, unknown>;

    for (const { name, options } of await routes()) {
      expect(options, `${name} has no @RateLimit`).toBeDefined();
      const limit = defaults[options!.configKey];
      expect(Number.isInteger(limit) && (limit as number) > 0, `${name}: ${options!.configKey} has no positive default`).toBe(true);

      if (PUBLIC.has(name.split('.')[0])) continue;

      const mine = options!.key(asUser('user-a'));
      expect(mine, `${name} buckets on something other than the caller`).toContain('user-a');
      expect(options!.key(asUser('user-b')), `${name} gives two users one budget`).not.toBe(mine);
    }
  });

  it('counts a public route on its own subject, since it has no caller', async () => {
    const found = (await routes()).filter((r) => PUBLIC.has(r.name.split('.')[0]));
    expect(new Set(found.map((r) => r.name.split('.')[0])).size, 'the public list names a controller that no longer exists').toBe(PUBLIC.size);

    for (const { name, options } of found) {
      const { subject, one, another } = PUBLIC.get(name.split('.')[0])!;
      expect(options!.key(one), `${name} does not count its subject`).toContain(subject);
      expect(options!.key(another), `${name} gives two subjects one budget`).not.toBe(options!.key(one));
      // No identity anywhere on the request: a public route that read one would
      // be reading a header nothing strips.
      expect(options!.key({ query: {}, params: {} })).toBeTruthy();
    }
  });

  it('enforces the limits on every route through the global guard', () => {
    const module = readFileSync(join(APP, 'app.module.ts'), 'utf8');
    expect(module).toMatch(/provide:\s*APP_GUARD,\s*useClass:\s*RateLimitGuard/);
  });
});
