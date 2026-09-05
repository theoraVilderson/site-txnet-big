import { RedisKeys, RedisTtl } from '../../redis/redis.keys';
import {
  RedisFixture,
  startRedisFixture,
} from '../../../test-support/redis-fixture';
import { CaptchaService } from './captcha.service';

/**
 * Two single-use guarantees live in Redis, not in this class: a challenge may
 * be answered at most once, and a pass may be spent at most once. Both are
 * "read then delete" against a shared server, so they are exercised against a
 * real one — including concurrently, which is the only shape in which a
 * double-spend would actually show up.
 *
 * The 250 ms interaction floor is exercised by rewriting the stored issue
 * timestamp rather than by sleeping: that pins the boundary exactly, and keeps
 * the suite from paying a quarter-second per case.
 */
describe('CaptchaService (real Redis)', () => {
  const MIN_INTERACTION_MS = 250;

  let fx: RedisFixture;
  let service: CaptchaService;

  const challengeKey = (id: string) =>
    fx.keyPrefix + RedisKeys.captchaChallenge(id);
  const passKey = (token: string) =>
    fx.keyPrefix + RedisKeys.captchaVerified(token);

  /** Backdate a live challenge so `elapsedMs` becomes exactly `ageMs`. */
  const ageChallenge = async (id: string, ageMs: number) => {
    await fx.raw.set(
      challengeKey(id),
      String(Date.now() - ageMs),
      'KEEPTTL',
    );
  };

  beforeAll(async () => {
    fx = await startRedisFixture();
    service = new CaptchaService(fx.redis);
  });

  afterAll(async () => {
    await fx?.stop();
  });

  beforeEach(async () => {
    await fx.flush();
  });

  describe('issueChallenge', () => {
    it('stores the issue timestamp under the challenge id', async () => {
      const before = Date.now();
      const { challengeId } = await service.issueChallenge();
      const after = Date.now();

      const stored = Number(await fx.raw.get(challengeKey(challengeId)));
      expect(stored).toBeGreaterThanOrEqual(before);
      expect(stored).toBeLessThanOrEqual(after);
    });

    it('attaches the catalogue TTL, so an abandoned widget cleans itself up', async () => {
      const { challengeId } = await service.issueChallenge();

      expect(await fx.raw.ttl(challengeKey(challengeId))).toBe(
        RedisTtl.captchaChallenge,
      );
    });

    it('never reuses a challenge id', async () => {
      const ids = await Promise.all(
        Array.from({ length: 25 }, () => service.issueChallenge()),
      );

      expect(new Set(ids.map((i) => i.challengeId)).size).toBe(25);
    });
  });

  describe('verifyChallenge — single use', () => {
    it('issues a pass for a plausibly-human slide', async () => {
      const { challengeId } = await service.issueChallenge();
      await ageChallenge(challengeId, 400);

      const result = await service.verifyChallenge(challengeId);

      expect(result).toMatchObject({ expiresIn: RedisTtl.captchaVerified });
      expect(await fx.raw.ttl(passKey(result!.token))).toBe(
        RedisTtl.captchaVerified,
      );
    });

    it('burns the challenge on success', async () => {
      const { challengeId } = await service.issueChallenge();
      await ageChallenge(challengeId, 400);

      await service.verifyChallenge(challengeId);

      expect(await fx.raw.exists(challengeKey(challengeId))).toBe(0);
      expect(await service.verifyChallenge(challengeId)).toBeNull();
    });

    it('burns the challenge on rejection too, so a slide cannot be retried', async () => {
      // Otherwise a bot answers instantly, is told "too fast", and simply
      // answers the same challenge again after waiting.
      const { challengeId } = await service.issueChallenge();

      expect(await service.verifyChallenge(challengeId)).toBeNull();
      expect(await fx.raw.exists(challengeKey(challengeId))).toBe(0);
    });

    it('rejects an unknown challenge id', async () => {
      expect(await service.verifyChallenge('not-a-challenge')).toBeNull();
    });

    it('rejects an expired challenge', async () => {
      const { challengeId } = await service.issueChallenge();
      await fx.raw.pexpire(challengeKey(challengeId), 60);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(await service.verifyChallenge(challengeId)).toBeNull();
    });

    it('hands out a distinct pass per verified challenge', async () => {
      const tokens: string[] = [];
      for (let i = 0; i < 5; i++) {
        const { challengeId } = await service.issueChallenge();
        await ageChallenge(challengeId, 400);
        tokens.push((await service.verifyChallenge(challengeId))!.token);
      }

      expect(new Set(tokens).size).toBe(5);
    });

    it('lets only one of two concurrent verifies win', async () => {
      const { challengeId } = await service.issueChallenge();
      await ageChallenge(challengeId, 400);

      const [a, b] = await Promise.all([
        service.verifyChallenge(challengeId),
        service.verifyChallenge(challengeId),
      ]);

      // One solved slide is one pass. This holds because verifyChallenge
      // reads and burns the challenge with a single GETDEL; a GET followed by
      // a DEL lets both callers read the timestamp and mint a token each.
      expect([a, b].filter(Boolean)).toHaveLength(1);
    });
  });

  describe('the MIN_INTERACTION_MS floor', () => {
    /**
     * Backdating alone cannot pin the boundary: the milliseconds spent on the
     * round-trip land on the wrong side of a one-millisecond margin. So the
     * issue timestamp is written directly and the clock is frozen for the
     * verify, making `elapsedMs` exactly `ageMs`.
     */
    const verifyAtAge = async (ageMs: number) => {
      const issuedAt = Date.now();
      const { challengeId } = await service.issueChallenge();
      await fx.raw.set(challengeKey(challengeId), String(issuedAt), 'KEEPTTL');

      const clock = jest
        .spyOn(Date, 'now')
        .mockReturnValue(issuedAt + ageMs);
      try {
        return await service.verifyChallenge(challengeId);
      } finally {
        clock.mockRestore();
      }
    };

    it('rejects a slide completed instantly', async () => {
      expect(await verifyAtAge(0)).toBeNull();
    });

    it('rejects one millisecond under the floor', async () => {
      expect(await verifyAtAge(MIN_INTERACTION_MS - 1)).toBeNull();
    });

    it('accepts exactly at the floor', async () => {
      // The check is `elapsedMs < MIN`, so the floor itself passes.
      expect(await verifyAtAge(MIN_INTERACTION_MS)).not.toBeNull();
    });

    it('accepts comfortably above the floor', async () => {
      expect(await verifyAtAge(MIN_INTERACTION_MS + 1)).not.toBeNull();
    });
  });

  describe('consumePass — single use', () => {
    const freshPass = async () => {
      const { challengeId } = await service.issueChallenge();
      await ageChallenge(challengeId, 400);
      return (await service.verifyChallenge(challengeId))!.token;
    };

    it('succeeds once and refuses every call after', async () => {
      const token = await freshPass();

      expect(await service.consumePass(token)).toBe(true);
      expect(await service.consumePass(token)).toBe(false);
    });

    it('deletes the pass as it spends it', async () => {
      const token = await freshPass();

      await service.consumePass(token);

      expect(await fx.raw.exists(passKey(token))).toBe(0);
    });

    it('refuses a missing token without touching Redis', async () => {
      expect(await service.consumePass(undefined)).toBe(false);
      expect(await service.consumePass('')).toBe(false);
    });

    it('refuses an unknown token', async () => {
      expect(await service.consumePass('not-a-pass')).toBe(false);
    });

    it('refuses an expired pass', async () => {
      const token = await freshPass();
      await fx.raw.pexpire(passKey(token), 60);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(await service.consumePass(token)).toBe(false);
    });

    it('spending one pass leaves another alone', async () => {
      const first = await freshPass();
      const second = await freshPass();

      await service.consumePass(first);

      expect(await service.consumePass(second)).toBe(true);
    });

    it('lets only one of two concurrent spends win', async () => {
      const token = await freshPass();

      const results = await Promise.all([
        service.consumePass(token),
        service.consumePass(token),
      ]);

      // consumePass returns the DEL count rather than testing EXISTS first,
      // so exactly one caller can win. This is what stops one solved captcha
      // from authorising two requests.
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });
});
