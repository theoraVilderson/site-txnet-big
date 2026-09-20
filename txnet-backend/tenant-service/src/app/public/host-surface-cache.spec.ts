import { HttpException } from '@nestjs/common';
import {
  HOST_SURFACE_MISS,
  RateLimitBucket,
  UnscopedRedisKeys,
  isHostSurface,
  rateLimitBucketKey,
} from '@txnet-backend/shared-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HostSurfaceCache } from './host-surface-cache.service';
import { PublicHostMiddleware } from './public-host.middleware';

/**
 * The Host half of a public route, cached and limited (F-018-al).
 *
 * The invariant this file exists for: **`tenant-service` writes, under
 * `tenant:host:<host>`, a value `auth-service` can read.** The two services
 * share that key on purpose — a second key is a second thing to delete at every
 * domain write, and the one that gets missed outlives a change of owner
 * (ADR-0025). They share it by sharing `shared-core`'s `HostSurface`, its
 * validator and its miss marker, which is what the shape assertions below pin.
 */

const ROW = {
  domainType: 'custom_domain',
  purpose: 'panel',
  verificationStatus: 'verified',
  tenant: { id: 'acme', slug: 'acme', ownerUserId: 'u-1', tenantType: 'reseller' },
};

function redisDouble() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setWithTtl: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    incrementWithTtl: vi.fn(async () => 1),
  };
}

function prismaDouble(rows: Record<string, unknown> = { 'shop-acme.com': ROW }) {
  return {
    tenantDomain: {
      findUnique: vi.fn(async ({ where }: { where: { domainValue: string } }) => rows[where.domainValue] ?? null),
    },
  };
}

describe('HostSurfaceCache', () => {
  let redis: ReturnType<typeof redisDouble>;
  let prisma: ReturnType<typeof prismaDouble>;
  let cache: HostSurfaceCache;

  beforeEach(() => {
    redis = redisDouble();
    prisma = prismaDouble();
    cache = new HostSurfaceCache(redis as never, prisma as never);
  });

  it('reads the row once and answers the second visitor from Redis', async () => {
    await expect(cache.of('shop-acme.com')).resolves.toMatchObject({ id: 'acme', purpose: 'panel' });
    await expect(cache.of('shop-acme.com')).resolves.toMatchObject({ id: 'acme', purpose: 'panel' });
    expect(prisma.tenantDomain.findUnique).toHaveBeenCalledTimes(1);
  });

  it('writes the shape auth-service reads, under the key it shares', async () => {
    await cache.of('shop-acme.com');
    const raw = redis.store.get(UnscopedRedisKeys.tenantByHost('shop-acme.com'));
    expect(raw).toBeDefined();
    // The assertion that keeps the two services on one key: auth-service's
    // reader is this same validator, so a value it would reject is a value
    // this must never write.
    expect(isHostSurface(JSON.parse(raw as string))).toBe(true);
    expect(Object.keys(JSON.parse(raw as string)).sort()).toEqual(
      ['domainType', 'id', 'ownerUserId', 'purpose', 'slug', 'tenantType'],
    );
  });

  it("caches a stranger's host as a miss, so a flood on it costs no query", async () => {
    await expect(cache.of('stranger.com')).resolves.toBeNull();
    expect(redis.store.get(UnscopedRedisKeys.tenantByHost('stranger.com'))).toBe(HOST_SURFACE_MISS);
    await expect(cache.of('stranger.com')).resolves.toBeNull();
    expect(prisma.tenantDomain.findUnique).toHaveBeenCalledTimes(1);
  });

  it('re-reads an entry whose shape this code no longer recognises', async () => {
    // A host entry written before `ownerUserId` was cached. It must not resolve
    // a request, and it must not be a permanent miss either.
    redis.store.set(UnscopedRedisKeys.tenantByHost('shop-acme.com'), JSON.stringify({ id: 'acme', slug: 'acme' }));
    await expect(cache.of('shop-acme.com')).resolves.toMatchObject({ ownerUserId: 'u-1' });
    expect(prisma.tenantDomain.findUnique).toHaveBeenCalledTimes(1);
  });

  it('falls back to the database when Redis cannot be read', async () => {
    redis.get.mockRejectedValueOnce(new Error('down'));
    await expect(cache.of('shop-acme.com')).resolves.toMatchObject({ id: 'acme' });
  });

  it('has nothing to look up without a host', async () => {
    await expect(cache.of(null)).resolves.toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
    expect(prisma.tenantDomain.findUnique).not.toHaveBeenCalled();
  });
});

describe('PublicHostMiddleware rate limit', () => {
  const LIMIT = 3;
  const config = { get: vi.fn(() => LIMIT) };

  function middlewareWith(hits: number[]) {
    const redis = redisDouble();
    const cache = new HostSurfaceCache(redis as never, prismaDouble() as never);
    let i = 0;
    const rateLimiter = {
      hit: vi.fn(async () => ({ allowed: hits[i] <= LIMIT, current: hits[i], limit: LIMIT })),
      hitPlatform: vi.fn(async () => ({ allowed: true, current: hits[i++], limit: LIMIT * 10 })),
    };
    return {
      rateLimiter,
      middleware: new PublicHostMiddleware(cache, rateLimiter as never, config as never),
    };
  }

  const request = (host: string, ip = '1.2.3.4') => ({ headers: { host }, ip }) as never;

  it("counts the visitor's IP inside the host's tenant, and the platform ceiling too", async () => {
    const { middleware, rateLimiter } = middlewareWith([1]);
    const next = vi.fn();
    await middleware.use(request('shop-acme.com'), {} as never, next);
    expect(next).toHaveBeenCalledOnce();
    const bucket = rateLimitBucketKey(RateLimitBucket.PUBLIC_ROUTE, '1.2.3.4');
    expect(rateLimiter.hit).toHaveBeenCalledWith(bucket, LIMIT, expect.any(Number));
    expect(rateLimiter.hitPlatform).toHaveBeenCalledWith(bucket, LIMIT, expect.any(Number));
  });

  it('refuses 429 over the limit, without running the route', async () => {
    const { middleware } = middlewareWith([LIMIT + 1]);
    const next = vi.fn();
    await expect(middleware.use(request('shop-acme.com'), {} as never, next)).rejects.toBeInstanceOf(HttpException);
    expect(next).not.toHaveBeenCalled();
  });

  it('counts a flood on a host that resolves to nothing', async () => {
    const { middleware, rateLimiter } = middlewareWith([1]);
    await middleware.use(request('stranger.com'), {} as never, vi.fn());
    expect(rateLimiter.hit).toHaveBeenCalledOnce();
  });
});
