import { RedisKeys, RedisTtl } from '../../redis/redis.keys';
import {
  RedisFixture,
  expectTtlSeconds,
  startRedisFixture,
} from '../../../test-support/redis-fixture';
import { OtpPurpose } from './otp.interface';
import { OtpStore } from './otp.store';
import { runWithTenant } from '../../tenant-context/tenant-context';

/**
 * Every OTP key carries the tenant it belongs to (ADR-0023), so each case has
 * to run inside the scope a real request would have opened. `it` is wrapped
 * once here rather than each body being wrapped, so a case added later cannot
 * forget and fail with `TenantContextMissing` instead of the thing it meant to
 * assert.
 */
const TENANT = { id: 'tenant-1', slug: 'reseller-a', via: 'domain' } as const;
const rawIt = it;

/**
 * The whole of OTP brute-force protection is one Lua script. It has to be
 * exact about three things at once — how many attempts it has spent, that it
 * does not extend the code's own lifetime while spending them, and that it
 * destroys the record rather than letting a sixth guess through — and all
 * three are properties of Redis, not of TypeScript. So this runs against a
 * real server.
 */
describe('OtpStore (real Redis)', () => {
  const it = (name: string, fn: () => Promise<void>) =>
    rawIt(name, () => runWithTenant(TENANT as never, fn));

  const PHONE = '09123456789';
  const PURPOSE = OtpPurpose.login;
  const HASH = 'argon2id$fake-hash';

  let fx: RedisFixture;
  let store: OtpStore;

  /** The literal key on the wire, prefix included. */
  const codeKey = () => fx.keyPrefix + RedisKeys.otpCode(PURPOSE, PHONE);
  const readPayload = async () => {
    const raw = await fx.raw.get(codeKey());
    return raw === null ? null : (JSON.parse(raw) as {
      codeHash: string;
      attemptCount: number;
    });
  };

  beforeAll(async () => {
    fx = await startRedisFixture();
    store = new OtpStore(fx.redis);
  });

  afterAll(async () => {
    await fx?.stop();
  });

  beforeEach(async () => {
    await fx.flush();
  });

  describe('save', () => {
    it('stores the hash with a zeroed counter under the namespaced key', async () => {
      await store.save(PHONE, PURPOSE, HASH);

      expect(await readPayload()).toEqual({
        codeHash: HASH,
        attemptCount: 0,
      });
    });

    it('attaches the catalogue TTL', async () => {
      await store.save(PHONE, PURPOSE, HASH);

      await expectTtlSeconds(fx.raw, codeKey(), RedisTtl.otpCode);
    });
  });

  describe('peekForVerification — the three statuses', () => {
    it('reports `missing` when no code was ever issued', async () => {
      expect(await store.peekForVerification(PHONE, PURPOSE)).toEqual({
        status: 'missing',
      });
    });

    it('reports `pending` with the stored hash while attempts remain', async () => {
      await store.save(PHONE, PURPOSE, HASH);

      expect(await store.peekForVerification(PHONE, PURPOSE)).toEqual({
        status: 'pending',
        codeHash: HASH,
      });
    });

    it('reports `missing`, not `exhausted`, once the record is gone', async () => {
      // The distinction matters to the caller: `exhausted` is the one that
      // tells the user to request a new code.
      await store.save(PHONE, PURPOSE, HASH);
      await fx.raw.del(codeKey());

      expect(await store.peekForVerification(PHONE, PURPOSE)).toEqual({
        status: 'missing',
      });
    });
  });

  describe('attempt accounting', () => {
    it('spends exactly one attempt per call', async () => {
      await store.save(PHONE, PURPOSE, HASH);

      for (const expected of [1, 2, 3]) {
        await store.peekForVerification(PHONE, PURPOSE);
        expect((await readPayload())?.attemptCount).toBe(expected);
      }
    });

    it('leaves the hash untouched while counting', async () => {
      await store.save(PHONE, PURPOSE, HASH);
      await store.peekForVerification(PHONE, PURPOSE);
      await store.peekForVerification(PHONE, PURPOSE);

      expect((await readPayload())?.codeHash).toBe(HASH);
    });

    it('allows five attempts, then destroys the record on the sixth', async () => {
      await store.save(PHONE, PURPOSE, HASH);

      for (let attempt = 1; attempt <= 5; attempt++) {
        expect(await store.peekForVerification(PHONE, PURPOSE)).toEqual({
          status: 'pending',
          codeHash: HASH,
        });
      }

      // Fifth call left attemptCount at 5; the sixth is the one that trips it.
      expect((await readPayload())?.attemptCount).toBe(5);
      expect(await fx.raw.exists(codeKey())).toBe(1);

      expect(await store.peekForVerification(PHONE, PURPOSE)).toEqual({
        status: 'exhausted',
      });
      expect(await fx.raw.exists(codeKey())).toBe(0);
    });

    it('does not hand back the hash on the exhausting attempt', async () => {
      // A leaked hash on the way out would give an offline attacker the one
      // thing five online guesses were meant to deny them.
      await store.save(PHONE, PURPOSE, HASH);
      for (let i = 0; i < 5; i++) {
        await store.peekForVerification(PHONE, PURPOSE);
      }

      const result = await store.peekForVerification(PHONE, PURPOSE);
      expect(JSON.stringify(result)).not.toContain(HASH);
    });

    it('a resent code starts the count over', async () => {
      await store.save(PHONE, PURPOSE, HASH);
      await store.peekForVerification(PHONE, PURPOSE);
      await store.peekForVerification(PHONE, PURPOSE);

      await store.save(PHONE, PURPOSE, 'second-hash');

      expect(await readPayload()).toEqual({
        codeHash: 'second-hash',
        attemptCount: 0,
      });
    });
  });

  describe('KEEPTTL — a wrong guess must not extend the code', () => {
    it('preserves the remaining TTL across an attempt', async () => {
      await store.save(PHONE, PURPOSE, HASH);
      // Stand in for "most of the 5 minutes has already elapsed" without
      // sleeping for it.
      await fx.raw.expire(codeKey(), 42);

      await store.peekForVerification(PHONE, PURPOSE);

      const ttl = await fx.raw.ttl(codeKey());
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(42);
    });

    it('cannot be kept alive indefinitely by guessing', async () => {
      await store.save(PHONE, PURPOSE, HASH);
      await fx.raw.expire(codeKey(), 30);

      for (let i = 0; i < 4; i++) {
        await store.peekForVerification(PHONE, PURPOSE);
      }

      expect(await fx.raw.ttl(codeKey())).toBeLessThanOrEqual(30);
    });

    it('lets the code expire mid-attempt rather than resurrecting it', async () => {
      await store.save(PHONE, PURPOSE, HASH);
      await fx.raw.pexpire(codeKey(), 60);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(await store.peekForVerification(PHONE, PURPOSE)).toEqual({
        status: 'missing',
      });
    });
  });

  describe('purpose and phone are separate namespaces', () => {
    it('does not let a login attempt spend a reset code', async () => {
      await store.save(PHONE, OtpPurpose.login, 'login-hash');
      await store.save(PHONE, OtpPurpose.password_reset, 'reset-hash');

      await store.peekForVerification(PHONE, OtpPurpose.login);

      const reset = await fx.raw.get(
        fx.keyPrefix + RedisKeys.otpCode(OtpPurpose.password_reset, PHONE),
      );
      expect(JSON.parse(reset!).attemptCount).toBe(0);
    });

    it('clears only the (purpose, phone) it was asked for', async () => {
      await store.save(PHONE, PURPOSE, HASH);
      await store.save('09120000000', PURPOSE, HASH);

      await store.clear(PHONE, PURPOSE);

      expect(await fx.raw.exists(codeKey())).toBe(0);
      expect(
        await fx.raw.exists(
          fx.keyPrefix + RedisKeys.otpCode(PURPOSE, '09120000000'),
        ),
      ).toBe(1);
    });
  });

  describe('issue lock', () => {
    it('is granted once and refused while held', async () => {
      expect(await store.acquireLock(PHONE, PURPOSE)).toBe(true);
      expect(await store.acquireLock(PHONE, PURPOSE)).toBe(false);
    });

    it('carries the catalogue TTL, so a crashed issue self-heals', async () => {
      await store.acquireLock(PHONE, PURPOSE);

      const ttl = await fx.raw.ttl(fx.keyPrefix + RedisKeys.otpLock(PURPOSE, PHONE));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(RedisTtl.otpLock);
    });

    it('is re-acquirable after release', async () => {
      await store.acquireLock(PHONE, PURPOSE);
      await store.releaseLock(PHONE, PURPOSE);

      expect(await store.acquireLock(PHONE, PURPOSE)).toBe(true);
    });

    it('does not block a different purpose for the same phone', async () => {
      await store.acquireLock(PHONE, OtpPurpose.login);

      expect(await store.acquireLock(PHONE, OtpPurpose.password_reset)).toBe(
        true,
      );
    });
  });

  describe('cooldown', () => {
    it('is off until started, then on', async () => {
      expect(await store.isCoolingDown(PHONE, PURPOSE)).toBe(false);

      await store.startCooldown(PHONE, PURPOSE);

      expect(await store.isCoolingDown(PHONE, PURPOSE)).toBe(true);
    });

    it('expires on its own', async () => {
      await store.startCooldown(PHONE, PURPOSE);
      const key = fx.keyPrefix + RedisKeys.otpCooldown(PURPOSE, PHONE);
      await expectTtlSeconds(fx.raw, key, RedisTtl.otpCooldown);

      await fx.raw.pexpire(key, 60);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(await store.isCoolingDown(PHONE, PURPOSE)).toBe(false);
    });
  });
});
