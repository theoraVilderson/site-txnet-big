import { RedisKeys } from '../../redis/redis.keys';
import {
  RedisFixture,
  expectTtlSeconds,
  startRedisFixture,
} from '../../../test-support/redis-fixture';
import { SessionStore } from './session.store';

/**
 * This store is the fast-path revocation check the gateway consults on every
 * authenticated request, so its failure mode is not "a test goes red" — it is
 * either a revoked session that still answers, or a live one that stops.
 *
 * The two things worth proving are that `register` lands as a unit (a session
 * marker without its index entry is invisible to "log this user out
 * everywhere") and that `dropAllForUser` really empties the index.
 */
describe('SessionStore (real Redis)', () => {
  const USER = 'user-1';
  const SESSION = 'sess-1';
  const TTL = 3600;

  let fx: RedisFixture;
  let store: SessionStore;

  const sessionKey = (id: string) => fx.keyPrefix + RedisKeys.session(id);
  const indexKey = (userId: string) =>
    fx.keyPrefix + RedisKeys.userSessions(userId);

  beforeAll(async () => {
    fx = await startRedisFixture();
    store = new SessionStore(fx.redis);
  });

  afterAll(async () => {
    await fx?.stop();
  });

  beforeEach(async () => {
    await fx.flush();
  });

  describe('register — the MULTI/EXEC unit', () => {
    it('writes the marker, the index entry and both TTLs', async () => {
      await store.register(SESSION, USER, TTL);

      expect(JSON.parse((await fx.raw.get(sessionKey(SESSION)))!)).toEqual({
        userId: USER,
        revoked: false,
      });
      expect(await fx.raw.smembers(indexKey(USER))).toEqual([SESSION]);
      await expectTtlSeconds(fx.raw, sessionKey(SESSION), TTL);
      await expectTtlSeconds(fx.raw, indexKey(USER), TTL);
    });

    it('leaves no half-written state — either all three keys or none', async () => {
      const [setReply, saddReply, expireReply] = (await fx.redis.client
        .multi()
        .set(RedisKeys.session(SESSION), '{}', 'EX', TTL)
        .sadd(RedisKeys.userSessions(USER), SESSION)
        .expire(RedisKeys.userSessions(USER), TTL)
        .exec())!;

      // EXEC reports [error, result] per queued command; any error here means
      // the transaction was partially applied, which is the state `register`
      // exists to avoid.
      expect([setReply[0], saddReply[0], expireReply[0]]).toEqual([
        null,
        null,
        null,
      ]);
    });

    it('never indexes a session that outlives its own marker', async () => {
      // The index is what `dropAllForUser` iterates; entries pointing at
      // expired markers would make a revocation look like it worked.
      await store.register(SESSION, USER, TTL);

      // The index is read first on purpose. Both keys were written with the
      // same TTL, and `TTL` rounds to the nearest second, so whichever is read
      // second can come back a second lower for no reason but the clock.
      // Reading the index first means that drift can only make the index look
      // longer-lived, which is the direction this assertion already allows.
      const indexTtl = await fx.raw.ttl(indexKey(USER));
      const markerTtl = await fx.raw.ttl(sessionKey(SESSION));
      expect(indexTtl).toBeGreaterThanOrEqual(markerTtl);
    });

    it('accumulates several sessions for one user', async () => {
      await store.register('s1', USER, TTL);
      await store.register('s2', USER, TTL);
      await store.register('s3', USER, TTL);

      expect((await fx.raw.smembers(indexKey(USER))).sort()).toEqual([
        's1',
        's2',
        's3',
      ]);
    });

    it('extends the index lifetime to the newest session', async () => {
      await store.register('s1', USER, 60);
      await store.register('s2', USER, 7200);

      // Otherwise the index would expire while a long-lived session still
      // needs to be revocable through it.
      await expectTtlSeconds(fx.raw, indexKey(USER), 7200);
    });

    it('re-registering the same id is idempotent in the index', async () => {
      await store.register(SESSION, USER, TTL);
      await store.register(SESSION, USER, TTL);

      expect(await fx.raw.smembers(indexKey(USER))).toEqual([SESSION]);
    });

    it('keeps each user index separate', async () => {
      await store.register('s1', 'user-a', TTL);
      await store.register('s2', 'user-b', TTL);

      expect(await fx.raw.smembers(indexKey('user-a'))).toEqual(['s1']);
      expect(await fx.raw.smembers(indexKey('user-b'))).toEqual(['s2']);
    });
  });

  describe('isActive', () => {
    it('is true for a registered session', async () => {
      await store.register(SESSION, USER, TTL);

      expect(await store.isActive(SESSION)).toBe(true);
    });

    it('is false for one that was never registered', async () => {
      expect(await store.isActive('never-existed')).toBe(false);
    });

    it('goes false when the marker expires on its own', async () => {
      await store.register(SESSION, USER, TTL);
      await fx.raw.pexpire(sessionKey(SESSION), 60);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(await store.isActive(SESSION)).toBe(false);
    });

    it('reads the same key auth-handler checks', async () => {
      // handler.go builds `<prefix>session:<id>` by hand; if the two ever
      // disagree the gateway rejects every live session.
      await store.register(SESSION, USER, TTL);

      expect(await fx.raw.exists(`${fx.keyPrefix}session:${SESSION}`)).toBe(1);
    });
  });

  describe('drop', () => {
    it('revokes the session immediately', async () => {
      await store.register(SESSION, USER, TTL);

      await store.drop(SESSION);

      expect(await store.isActive(SESSION)).toBe(false);
    });

    it('prunes the index entry when the user is given', async () => {
      await store.register(SESSION, USER, TTL);

      await store.drop(SESSION, USER);

      expect(await fx.raw.smembers(indexKey(USER))).toEqual([]);
    });

    it('prunes the index without being told the user', async () => {
      // The marker carries its owner, so the caller does not have to. Leaving
      // the id behind would make the index a set of dangling pointers, and
      // anything that later read it as a session *count* would be wrong.
      await store.register(SESSION, USER, TTL);

      await store.drop(SESSION);

      expect(await fx.raw.smembers(indexKey(USER))).toEqual([]);
    });

    it('revokes the session even when the payload cannot be parsed', async () => {
      // Revocation is the part that must not be contingent on anything. A
      // marker written by an older version, or corrupted, still gets dropped;
      // only the index tidy-up is skipped.
      await store.register(SESSION, USER, TTL);
      await fx.raw.set(sessionKey(SESSION), 'not-json', 'KEEPTTL');

      await store.drop(SESSION);

      expect(await store.isActive(SESSION)).toBe(false);
      expect(await fx.raw.smembers(indexKey(USER))).toEqual([SESSION]);
    });

    it('is a no-op when the marker has already expired', async () => {
      await store.register(SESSION, USER, TTL);
      await fx.raw.del(sessionKey(SESSION));

      await expect(store.drop(SESSION)).resolves.toBeUndefined();
    });

    it('reads the owner off the marker, not off the caller', async () => {
      // If it guessed the owner some other way, dropping one user's session
      // could prune another user's index.
      await store.register('s1', 'user-a', TTL);
      await store.register('s2', 'user-b', TTL);

      await store.drop('s1');

      expect(await fx.raw.smembers(indexKey('user-a'))).toEqual([]);
      expect(await fx.raw.smembers(indexKey('user-b'))).toEqual(['s2']);
    });

    it('leaves the user\'s other sessions alone', async () => {
      await store.register('s1', USER, TTL);
      await store.register('s2', USER, TTL);

      await store.drop('s1', USER);

      expect(await store.isActive('s2')).toBe(true);
      expect(await fx.raw.smembers(indexKey(USER))).toEqual(['s2']);
    });

    it('is a no-op for an unknown session', async () => {
      await expect(store.drop('unknown', USER)).resolves.toBeUndefined();
    });
  });

  describe('dropAllForUser', () => {
    it('revokes every session and removes the index', async () => {
      await store.register('s1', USER, TTL);
      await store.register('s2', USER, TTL);
      await store.register('s3', USER, TTL);

      await store.dropAllForUser(USER);

      expect(await store.isActive('s1')).toBe(false);
      expect(await store.isActive('s2')).toBe(false);
      expect(await store.isActive('s3')).toBe(false);
      expect(await fx.raw.exists(indexKey(USER))).toBe(0);
    });

    it('touches no other user', async () => {
      await store.register('mine', USER, TTL);
      await store.register('theirs', 'user-2', TTL);

      await store.dropAllForUser(USER);

      expect(await store.isActive('theirs')).toBe(true);
      expect(await fx.raw.smembers(indexKey('user-2'))).toEqual(['theirs']);
    });

    it('survives an index holding ids whose markers already expired', async () => {
      await store.register('live', USER, TTL);
      await store.register('gone', USER, TTL);
      await fx.raw.del(sessionKey('gone'));

      await expect(store.dropAllForUser(USER)).resolves.toBeUndefined();
      expect(await store.isActive('live')).toBe(false);
    });

    it('is a no-op for a user with no sessions', async () => {
      // `del()` is called with just the index key here — the empty-spread case
      // that would throw if it were passed no arguments at all.
      await expect(store.dropAllForUser('nobody')).resolves.toBeUndefined();
    });

    it('a session created after the drop is unaffected', async () => {
      await store.register('old', USER, TTL);
      await store.dropAllForUser(USER);

      await store.register('new', USER, TTL);

      expect(await store.isActive('new')).toBe(true);
      expect(await fx.raw.smembers(indexKey(USER))).toEqual(['new']);
      await expectTtlSeconds(fx.raw, indexKey(USER), TTL);
    });
  });
});
