import { RedisKeys, RedisTtl } from '../redis/redis.keys';
import { TenantCacheService } from './tenant-cache.service';

/**
 * The invariant this file exists for is not "the cache is fast". It is that a
 * mapping stops being served the moment the write that changed it says so
 * (ADR-0025, catalog F-1211) — because the alternative is that a host whose
 * owner changed keeps resolving to the previous tenant, and every scoped query
 * on that request then reads the wrong tenant's rows while looking exactly
 * like success. The TTL is only a bound on how long that can last if a writer
 * forgets, so the assertions below are about invalidation, about the
 * miss/hit distinction that keeps a stranger's host off the database, and
 * about not failing a request when Redis is unavailable.
 */

const TENANT = { id: 'tenant-reseller', slug: 'reseller' };

function cacheOver(redis: Partial<Record<'get' | 'set' | 'del', jest.Mock>>) {
  const store = new Map<string, string>();
  const client = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    del: jest.fn(async (...keys: string[]) => {
      keys.forEach((key) => store.delete(key));
    }),
    ...redis,
  };
  return { cache: new TenantCacheService(client as never), client, store };
}

describe('TenantCacheService — invalidation, not expiry', () => {
  it('forgets a domain, so the next read goes back to the database', async () => {
    const { cache } = cacheOver({});
    const lookup = jest
      .fn<Promise<typeof TENANT | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(TENANT);

    await expect(cache.byHost('myvpn.com', lookup)).resolves.toBeNull();
    await cache.invalidateDomain('myvpn.com');
    await expect(cache.byHost('myvpn.com', lookup)).resolves.toEqual(TENANT);

    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('normalizes the host it is asked to forget, so a stored `domainValue` reaches the cached key', async () => {
    // The writer holds `tenant_domain.domainValue`; the reader held a header.
    // If those produced two keys, invalidation would delete a key nobody reads
    // and leave the live one in place — a silent no-op, which is the worst
    // shape this failure can take.
    const { cache, store } = cacheOver({});
    await cache.byHost('myvpn.com', async () => TENANT);

    await cache.invalidateDomain('  MyVPN.com:8443  ');

    expect(store.has(RedisKeys.tenantByHost('myvpn.com'))).toBe(false);
  });

  it('forgets a tenant id, so a token outliving its tenant stops answering its own claim', async () => {
    const { cache } = cacheOver({});
    const lookup = jest
      .fn<Promise<typeof TENANT | null>, []>()
      .mockResolvedValueOnce(TENANT)
      .mockResolvedValueOnce(null);

    await expect(cache.byId(TENANT.id, lookup)).resolves.toEqual(TENANT);
    await cache.invalidateTenant(TENANT.id);
    await expect(cache.byId(TENANT.id, lookup)).resolves.toBeNull();
  });

  it('throws when it cannot retract a mapping, rather than reporting a switchover that did not happen', async () => {
    const { cache } = cacheOver({
      del: jest.fn(async () => {
        throw new Error('redis down');
      }),
    });

    await expect(cache.invalidateDomain('myvpn.com')).rejects.toThrow('redis down');
  });

  it('does not spend a round trip retracting a host that is not a host', async () => {
    const { cache, client } = cacheOver({});

    await cache.invalidateDomain('');
    await cache.invalidateDomain(null);

    expect(client.del).not.toHaveBeenCalled();
  });
});

describe('TenantCacheService — a cached "no tenant" is an answer', () => {
  it('serves an unknown host from the cache instead of the database', async () => {
    const { cache } = cacheOver({});
    const lookup = jest.fn(async () => null);

    await cache.byHost('stranger.example', lookup);
    await expect(cache.byHost('stranger.example', lookup)).resolves.toBeNull();

    // Without a marker distinguishing "not cached" from "cached as nothing",
    // every invented hostname would reach Postgres.
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps a negative answer for much less time than a positive one', async () => {
    // A miss is what a stranger's host writes, so its lifetime bounds how many
    // keys a flood of invented hostnames holds at once.
    const { cache, client } = cacheOver({});

    await cache.byHost('myvpn.com', async () => TENANT);
    await cache.byHost('stranger.example', async () => null);

    expect(client.set).toHaveBeenNthCalledWith(
      1,
      RedisKeys.tenantByHost('myvpn.com'),
      JSON.stringify(TENANT),
      RedisTtl.tenantResolution,
    );
    expect(client.set).toHaveBeenNthCalledWith(
      2,
      RedisKeys.tenantByHost('stranger.example'),
      expect.any(String),
      RedisTtl.tenantResolutionMiss,
    );
    expect(RedisTtl.tenantResolutionMiss).toBeLessThan(RedisTtl.tenantResolution);
  });
});

describe('TenantCacheService — a Redis outage slows resolution, it does not refuse it', () => {
  it('falls back to the database when the read throws', async () => {
    const { cache } = cacheOver({
      get: jest.fn(async () => {
        throw new Error('redis down');
      }),
    });

    // The alternative is a neutral 404 on every request while the database
    // still knows which tenant owns the host.
    await expect(cache.byHost('myvpn.com', async () => TENANT)).resolves.toEqual(
      TENANT,
    );
  });

  it('still answers when the write throws', async () => {
    const { cache } = cacheOver({
      set: jest.fn(async () => {
        throw new Error('redis down');
      }),
    });

    await expect(cache.byHost('myvpn.com', async () => TENANT)).resolves.toEqual(
      TENANT,
    );
  });

  it('re-reads rather than trusting a value it cannot parse', async () => {
    const { cache, store } = cacheOver({});
    store.set(RedisKeys.tenantByHost('myvpn.com'), 'not json');

    await expect(cache.byHost('myvpn.com', async () => TENANT)).resolves.toEqual(
      TENANT,
    );
    expect(store.get(RedisKeys.tenantByHost('myvpn.com'))).toBe(
      JSON.stringify(TENANT),
    );
  });
});
