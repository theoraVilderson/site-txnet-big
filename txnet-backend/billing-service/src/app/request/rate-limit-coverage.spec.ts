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
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RATE_LIMIT_KEY, RateLimitOptions } from '@txnet-backend/shared-core';

import { envSchema } from '../config/env.validation';

const APP = join(__dirname, '..');
const EXEMPT = new Set(['HealthController']);

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return controllerFiles(path);
    return e.name.endsWith('.controller.ts') ? [path] : [];
  });
}

type Route = { name: string; options: RateLimitOptions | undefined };

async function routes(): Promise<Route[]> {
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
    const defaults = envSchema.parse({ DATABASE_APP_URL: 'x', REDIS_URL: 'x' }) as Record<string, unknown>;

    for (const { name, options } of await routes()) {
      expect(options, `${name} has no @RateLimit`).toBeDefined();
      const limit = defaults[options!.configKey];
      expect(Number.isInteger(limit) && (limit as number) > 0, `${name}: ${options!.configKey} has no positive default`).toBe(true);

      const mine = options!.key(asUser('user-a'));
      expect(mine, `${name} buckets on something other than the caller`).toContain('user-a');
      expect(options!.key(asUser('user-b')), `${name} gives two users one budget`).not.toBe(mine);
    }
  });

  it('enforces the limits on every route through the global guard', () => {
    const module = readFileSync(join(APP, 'app.module.ts'), 'utf8');
    expect(module).toMatch(/provide:\s*APP_GUARD,\s*useClass:\s*RateLimitGuard/);
  });
});
