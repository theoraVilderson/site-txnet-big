import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { EDGE_CLAIMED_IP_HEADER } from '../http/headers';
import { runWithTenant } from '../tenant-context/tenant-context';
import { RateLimitGuard } from './rate-limit.guard';
import type { RateLimitOptions } from './rate-limit.decorator';
import { RateLimiter, SHARED_ADDRESS_FACTOR, type RateLimitStore } from './rate-limiter';

const TENANT = { id: 'tenant-a', slug: 'reseller-a', via: 'domain' } as const;
const EDGE = '185.215.232.193';

/**
 * EDGE-1-l, ADR-0129 amendment 2. Behind a reseller's own CDN the verified
 * address is that CDN's edge, shared by every visitor it serves. The gateway
 * forwards what the CDN claims the visitor was; the limiter counts that claim
 * beside the address and never trusts it.
 */
describe('a per-IP limit behind a shared address', () => {
  const counts = new Map<string, number>();
  const store: RateLimitStore = {
    incrementWithTtl: async (key) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    del: async (key) => counts.delete(key),
  };
  const config = {
    get: (key: string) => (key === 'LOGIN_RATE_LIMIT' ? 2 : key === 'PLATFORM_RATE_LIMIT_FACTOR' ? 10 : undefined),
  } as unknown as ConfigService;

  const byCaller: RateLimitOptions = {
    key: (req) => `login:pwd:${req.user?.sub ?? req.ip}`,
    configKey: 'LOGIN_RATE_LIMIT',
    windowSec: 900,
  };
  const guard = new RateLimitGuard(
    { getAllAndOverride: () => byCaller } as unknown as Reflector,
    new RateLimiter(store, config),
    config,
  );

  const request = (ip: string, claim?: string, user?: string) => ({
    ip,
    headers: claim === undefined ? {} : { [EDGE_CLAIMED_IP_HEADER.toLowerCase()]: claim },
    ...(user ? { user: { sub: user } } : {}),
  });
  const pass = (req: object) =>
    runWithTenant(TENANT, () =>
      guard.canActivate({
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext),
    ).then(
      () => true,
      (e) => {
        if (e instanceof HttpException && e.getStatus() === 429) return false;
        throw e;
      },
    );

  beforeEach(() => counts.clear());

  it('without a claim, counts the address exactly as before', async () => {
    expect(await pass(request('203.0.113.9'))).toBe(true);
    expect([...counts.keys()]).toEqual([
      'ratelimit:tenant-a:login:pwd:203.0.113.9',
      'ratelimit:platform:login:pwd:203.0.113.9',
    ]);
  });

  it('gives each visitor behind one CDN edge a budget of their own', async () => {
    const attacker = () => pass(request(EDGE, '198.51.100.66'));
    expect(await attacker()).toBe(true);
    expect(await attacker()).toBe(true);
    expect(await attacker()).toBe(false);

    // Same edge, someone else: the attacker spent only their own budget.
    expect(await pass(request(EDGE, '104.248.193.151'))).toBe(true);
  });

  it('counts both halves in the tenant and the platform counters', async () => {
    await pass(request(EDGE, '104.248.193.151'));
    expect([...counts.keys()].sort()).toEqual([
      `ratelimit:platform:login:pwd:${EDGE}`,
      `ratelimit:platform:login:pwd:${EDGE}~104.248.193.151`,
      `ratelimit:tenant-a:login:pwd:${EDGE}`,
      `ratelimit:tenant-a:login:pwd:${EDGE}~104.248.193.151`,
    ]);
  });

  // A forged claim is a new fine counter each time; the address it really
  // came from is still counted, at a multiple of the route's limit.
  it('stops a caller who invents a new claim every time at the coarse ceiling', async () => {
    const ceiling = 2 * SHARED_ADDRESS_FACTOR;
    for (let i = 0; i < ceiling; i++) expect(await pass(request(EDGE, `10.0.${i >> 8}.${i & 255}`))).toBe(true);
    expect(await pass(request(EDGE, '10.9.9.9'))).toBe(false);
  });

  it('ignores a claim on a bucket that is not keyed on the address', async () => {
    await pass(request(EDGE, '104.248.193.151', 'user-1'));
    expect([...counts.keys()]).toEqual(['ratelimit:tenant-a:login:pwd:user-1', 'ratelimit:platform:login:pwd:user-1']);
  });

  it('ignores a claim that is not an address, or is the address itself', async () => {
    for (const claim of ['', 'nope', '1.1.1.1, 2.2.2.2', EDGE, `${EDGE}:443`]) {
      counts.clear();
      await pass(request(EDGE, claim));
      expect([...counts.keys()]).toEqual([`ratelimit:tenant-a:login:pwd:${EDGE}`, `ratelimit:platform:login:pwd:${EDGE}`]);
    }
  });
});
