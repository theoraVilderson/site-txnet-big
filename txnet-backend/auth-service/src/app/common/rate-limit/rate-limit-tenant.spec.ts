import { RateLimiter } from './rate-limiter';
import { RedisService } from '../../redis/redis.service';
import { runWithTenant } from '../../tenant-context/tenant-context';

const TENANT_A = { id: 'tenant-a', slug: 'reseller-a', via: 'domain' } as const;
const TENANT_B = { id: 'tenant-b', slug: 'reseller-b', via: 'domain' } as const;

/**
 * Catalog 20.2 layer 6 (F-1206): a rate-limit bucket belongs to one tenant.
 *
 * The bucket string is chosen by the route and is built from things that are
 * *not* the platform's to allocate — an IP, a messenger chat id, a username, a
 * phone number. Every one of those is the same value in two resellers' front
 * doors, so one tenant's traffic used to spend another's budget and, worse,
 * `login-failures:<identity>` locked a reseller's `admin` out because a
 * different reseller's `admin` was being guessed at.
 *
 * Asserted through `RateLimiter` rather than `RedisKeys` because the limiter is
 * what every caller actually holds: the guard, the login failure counter and
 * the reset path all go through `hit`/`reset`, and a key that is only correct
 * when built directly is not the thing being relied on.
 */
describe('rate-limit buckets are per tenant', () => {
  const keys: string[] = [];
  const redis = {
    incrementWithTtl: jest.fn(async (key: string) => {
      keys.push(key);
      return 1;
    }),
    del: jest.fn(async (key: string) => {
      keys.push(key);
    }),
  } as unknown as RedisService;
  const limiter = new RateLimiter(redis);

  beforeEach(() => {
    keys.length = 0;
  });

  it('gives two tenants two counters for one bucket string', async () => {
    await runWithTenant(TENANT_A, async () => {
      await limiter.hit('login:pwd:203.0.113.9', 5, 60);
    });
    await runWithTenant(TENANT_B, async () => {
      await limiter.hit('login:pwd:203.0.113.9', 5, 60);
    });

    expect(keys).toEqual([
      'ratelimit:tenant-a:login:pwd:203.0.113.9',
      'ratelimit:tenant-b:login:pwd:203.0.113.9',
    ]);
  });

  it('resets only the calling tenant, never its neighbour', async () => {
    await runWithTenant(TENANT_A, async () => {
      await limiter.reset('login-failures:admin');
    });

    expect(keys).toEqual(['ratelimit:tenant-a:login-failures:admin']);
  });

  it('still counts a request that resolved to no tenant, under its own segment', async () => {
    // Unlike the phone-derived keys, this one must not throw: a request to a
    // host that matches no `tenant_domain` row is exactly what a flood looks
    // like, and it has to stay countable while `TenantGuard` answers it a 404.
    // The segment is a literal no tenant id can equal, so the unresolved
    // bucket cannot be reached from inside a tenant.
    await runWithTenant(null, async () => {
      await limiter.hit('captcha:challenge:203.0.113.9', 5, 60);
    });

    expect(keys).toEqual(['ratelimit:none:captcha:challenge:203.0.113.9']);
  });
});
