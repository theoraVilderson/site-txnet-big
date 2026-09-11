import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { RateLimiter } from './rate-limiter';
import { RateLimitGuard } from '../guards/rate-limit.guard';
import { RedisService } from '../../redis/redis.service';
import { runWithTenant } from '../../tenant-context/tenant-context';
import { RateLimitOptions } from '../../auth/decorators/rate-limit.decorator';
import { fakeExecutionContext } from '../../../test-support/execution-context';

const TENANT_A = { id: 'tenant-a', slug: 'reseller-a', via: 'domain' } as const;
const TENANT_B = { id: 'tenant-b', slug: 'reseller-b', via: 'domain' } as const;

/**
 * F-066-s — the half F-066-o left open.
 *
 * Per-tenant buckets stopped one reseller's traffic from spending another's
 * budget, and paid for it: an attacker who can address N tenants from one IP
 * gets N budgets, because every one of those counters is keyed on a tenant it
 * chooses by picking a hostname. The platform-wide counter is the same bucket
 * string with no tenant in it, so the N collapse back into one.
 *
 * The two halves answer opposite failures and neither replaces the other: the
 * tenant counter is what keeps a neighbour's flood off your users, and the
 * platform counter is what keeps the flood from being free.
 */
describe('the platform-wide rate-limit ceiling', () => {
  const keys: string[] = [];
  const counts = new Map<string, number>();
  const redis = {
    incrementWithTtl: jest.fn(async (key: string) => {
      keys.push(key);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    }),
    del: jest.fn(async (key: string) => {
      keys.push(key);
    }),
  } as unknown as RedisService;

  const limiterWithFactor = (factor: number) =>
    new RateLimiter(redis, {
      get: jest.fn(() => factor),
    } as unknown as ConfigService);

  beforeEach(() => {
    keys.length = 0;
    counts.clear();
  });

  it('counts two tenants addressed from one IP into one platform counter', async () => {
    const limiter = limiterWithFactor(10);

    await runWithTenant(TENANT_A, () =>
      limiter.hitPlatform('login:pwd:203.0.113.9', 5, 900),
    );
    await runWithTenant(TENANT_B, () =>
      limiter.hitPlatform('login:pwd:203.0.113.9', 5, 900),
    );

    expect(keys).toEqual([
      'ratelimit:platform:login:pwd:203.0.113.9',
      'ratelimit:platform:login:pwd:203.0.113.9',
    ]);
    expect(counts.get('ratelimit:platform:login:pwd:203.0.113.9')).toBe(2);
  });

  // The ceiling is a multiple of the route's own limit, so one number governs
  // every route and a route that raises its limit raises its ceiling with it.
  it('refuses once the caller has spent the whole platform ceiling', async () => {
    const limiter = limiterWithFactor(3);
    const spend = () =>
      runWithTenant(TENANT_A, () => limiter.hitPlatform('login:pwd:ip', 2, 900));

    for (let i = 0; i < 6; i++) expect((await spend()).allowed).toBe(true);

    const refused = await spend();
    expect(refused.allowed).toBe(false);
    expect(refused.limit).toBe(6);
  });

  it('writes no platform counter at all when the factor is zero', async () => {
    const limiter = limiterWithFactor(0);

    const result = await runWithTenant(TENANT_A, () =>
      limiter.hitPlatform('login:pwd:ip', 5, 900),
    );

    expect(result.allowed).toBe(true);
    expect(keys).toEqual([]);
  });

  // The reason this is a separate method rather than something `hit` does for
  // every caller: `login-failures:<identity>` is not keyed on the caller. A
  // platform-wide counter over it would lock every reseller's `admin` out
  // because one reseller's was guessed at — the exact denial of service
  // F-066-o closed.
  it('leaves the tenant-scoped counter untouched', async () => {
    const limiter = limiterWithFactor(10);

    await runWithTenant(TENANT_A, () =>
      limiter.hit('login-failures:admin', 10, 900),
    );

    expect(keys).toEqual(['ratelimit:tenant-a:login-failures:admin']);
  });

  describe('through the guard', () => {
    const route: RateLimitOptions = {
      key: (req) => `login:pwd:${req.ip}`,
      configKey: 'LOGIN_PWD_RATE_LIMIT',
      windowSec: 900,
    };
    const guardWith = (limiter: RateLimiter) =>
      new RateLimitGuard(
        {
          getAllAndOverride: jest.fn().mockReturnValue(route),
        } as unknown as Reflector,
        limiter,
        {
          get: jest.fn(() => 2),
        } as unknown as ConfigService,
      );
    const call = () => fakeExecutionContext({ extra: { ip: '203.0.113.9' } });

    it('counts one request in both the tenant bucket and the platform one', async () => {
      const guard = guardWith(limiterWithFactor(10));

      await runWithTenant(TENANT_A, () => guard.canActivate(call().context));

      expect(keys).toEqual([
        'ratelimit:tenant-a:login:pwd:203.0.113.9',
        'ratelimit:platform:login:pwd:203.0.113.9',
      ]);
    });

    it('answers 429 on the platform ceiling with every tenant budget unspent', async () => {
      // Factor 1 makes the ceiling equal to one tenant's budget, so the third
      // request across two tenants crosses it while neither tenant has.
      const guard = guardWith(limiterWithFactor(1));

      await runWithTenant(TENANT_A, () => guard.canActivate(call().context));
      await runWithTenant(TENANT_B, () => guard.canActivate(call().context));

      await expect(
        runWithTenant(TENANT_A, () => guard.canActivate(call().context)),
      ).rejects.toMatchObject({ status: 429 });
      expect(counts.get('ratelimit:tenant-a:login:pwd:203.0.113.9')).toBe(2);
      expect(counts.get('ratelimit:tenant-b:login:pwd:203.0.113.9')).toBe(1);
    });

    it('still refuses on the tenant bucket when the platform one is fine', async () => {
      const guard = guardWith(limiterWithFactor(100));

      await runWithTenant(TENANT_A, () => guard.canActivate(call().context));
      await runWithTenant(TENANT_A, () => guard.canActivate(call().context));

      await expect(
        runWithTenant(TENANT_A, () => guard.canActivate(call().context)),
      ).rejects.toThrow(HttpException);
    });
  });
});
