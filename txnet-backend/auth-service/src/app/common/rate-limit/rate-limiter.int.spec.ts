import { RedisKeys } from '../../redis/redis.keys';
import {
  RedisFixture,
  startRedisFixture,
} from '../../../test-support/redis-fixture';
import { RateLimiter } from './rate-limiter';

/**
 * A fixed window is only a rate limit if the TTL is attached to the counter in
 * the same round-trip that creates it. If it is not, a process that dies
 * between INCR and EXPIRE leaves an immortal counter behind, and the bucket it
 * belongs to — a phone number, an IP — is locked out permanently. That is a
 * Lua/Redis property, so it is tested here against a real server rather than
 * asserted against a mock.
 */
describe('RateLimiter (real Redis)', () => {
  const BUCKET = 'login:1.2.3.4';
  const key = () => fx.keyPrefix + RedisKeys.rateLimit(BUCKET);

  let fx: RedisFixture;
  let limiter: RateLimiter;

  beforeAll(async () => {
    fx = await startRedisFixture();
    limiter = new RateLimiter(fx.redis);
  });

  afterAll(async () => {
    await fx?.stop();
  });

  beforeEach(async () => {
    await fx.flush();
  });

  describe('the window', () => {
    it('attaches the TTL on the very first hit', async () => {
      await limiter.hit(BUCKET, 5, 60);

      expect(await fx.raw.ttl(key())).toBe(60);
    });

    it('never leaves a counter without an expiry', async () => {
      // -1 is the reply that means "key exists, no TTL" — the immortal-counter
      // failure this script exists to prevent.
      for (let i = 0; i < 4; i++) {
        await limiter.hit(BUCKET, 5, 60);
        expect(await fx.raw.ttl(key())).toBeGreaterThan(0);
      }
    });

    it('does not slide: later hits leave the first hit\'s deadline alone', async () => {
      await limiter.hit(BUCKET, 10, 60);
      // Stand in for "50 of the 60 seconds have passed".
      await fx.raw.expire(key(), 10);

      await limiter.hit(BUCKET, 10, 60);
      await limiter.hit(BUCKET, 10, 60);

      expect(await fx.raw.ttl(key())).toBeLessThanOrEqual(10);
    });

    it('starts a fresh window, from 1, once the old one expires', async () => {
      await limiter.hit(BUCKET, 2, 60);
      await limiter.hit(BUCKET, 2, 60);
      await fx.raw.pexpire(key(), 60);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const afterExpiry = await limiter.hit(BUCKET, 2, 60);

      expect(afterExpiry).toEqual({ allowed: true, current: 1, limit: 2 });
      expect(await fx.raw.ttl(key())).toBe(60);
    });
  });

  describe('the boundary — allowed is `current <= limit`', () => {
    it('counts up from 1, not 0', async () => {
      expect(await limiter.hit(BUCKET, 3, 60)).toEqual({
        allowed: true,
        current: 1,
        limit: 3,
      });
    });

    it('allows exactly `limit` requests and denies the next', async () => {
      const limit = 3;
      const results = [];
      for (let i = 0; i < limit + 2; i++) {
        results.push(await limiter.hit(BUCKET, limit, 60));
      }

      expect(results.map((r) => r.allowed)).toEqual([
        true,
        true,
        true,
        false,
        false,
      ]);
      expect(results.map((r) => r.current)).toEqual([1, 2, 3, 4, 5]);
    });

    it('keeps counting past the limit, so callers can see how far over it is', async () => {
      for (let i = 0; i < 5; i++) await limiter.hit(BUCKET, 1, 60);

      expect(await limiter.hit(BUCKET, 1, 60)).toEqual({
        allowed: false,
        current: 6,
        limit: 1,
      });
    });

    it('denies everything when the limit is zero', async () => {
      expect((await limiter.hit(BUCKET, 0, 60)).allowed).toBe(false);
    });
  });

  describe('bucket isolation', () => {
    it('counts each bucket separately', async () => {
      await limiter.hit('login:1.1.1.1', 5, 60);
      await limiter.hit('login:1.1.1.1', 5, 60);

      expect(await limiter.hit('login:2.2.2.2', 5, 60)).toMatchObject({
        current: 1,
      });
    });

    it('writes under the namespaced ratelimit key, not a bare bucket name', async () => {
      await limiter.hit(BUCKET, 5, 60);

      expect(await fx.raw.get(key())).toBe('1');
      expect(await fx.raw.exists(BUCKET)).toBe(0);
    });
  });

  describe('reset', () => {
    it('clears the counter so the next hit starts a new window', async () => {
      await limiter.hit(BUCKET, 3, 60);
      await limiter.hit(BUCKET, 3, 60);

      await limiter.reset(BUCKET);

      expect(await fx.raw.exists(key())).toBe(0);
      expect(await limiter.hit(BUCKET, 3, 60)).toEqual({
        allowed: true,
        current: 1,
        limit: 3,
      });
    });

    it('is a no-op on a bucket that was never hit', async () => {
      await expect(limiter.reset('never-used')).resolves.toBeUndefined();
    });

    it('touches only the bucket it was given', async () => {
      await limiter.hit('a', 5, 60);
      await limiter.hit('b', 5, 60);

      await limiter.reset('a');

      expect(await fx.raw.exists(fx.keyPrefix + RedisKeys.rateLimit('b'))).toBe(1);
    });
  });

  describe('concurrency', () => {
    it('loses no hits when a burst arrives at once', async () => {
      // INCR is atomic; the point is that the script around it does not turn a
      // burst into a read-modify-write race that under-counts.
      const burst = await Promise.all(
        Array.from({ length: 20 }, () => limiter.hit(BUCKET, 10, 60)),
      );

      expect(new Set(burst.map((r) => r.current)).size).toBe(20);
      expect(Math.max(...burst.map((r) => r.current))).toBe(20);
      expect(burst.filter((r) => r.allowed)).toHaveLength(10);
    });
  });
});
