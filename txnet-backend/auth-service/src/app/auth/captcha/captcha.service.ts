import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys, RedisTtl } from '../../redis/redis.keys';

/**
 * Minimum time between a challenge being issued and a completed slide. A
 * scripted call to `/verify` right after `/challenge` cannot be a human
 * dragging the widget — this is a best-effort heuristic, not proof of
 * humanity (see F-0201 note in the feature catalog).
 */
const MIN_INTERACTION_MS = 250;

@Injectable()
export class CaptchaService {
  constructor(private readonly redis: RedisService) {}

  async issueChallenge(): Promise<{ challengeId: string }> {
    const challengeId = randomUUID();
    await this.redis.set(
      RedisKeys.captchaChallenge(challengeId),
      String(Date.now()),
      RedisTtl.captchaChallenge,
    );
    return { challengeId };
  }

  /**
   * Confirms a completed slide and issues a short-lived, single-use pass.
   * Returns `null` for an unknown/expired/already-used challenge, or one
   * completed too fast to be a real drag gesture.
   */
  async verifyChallenge(
    challengeId: string,
  ): Promise<{ token: string; expiresIn: number } | null> {
    const key = RedisKeys.captchaChallenge(challengeId);
    const issuedAtRaw = await this.redis.get(key);
    if (!issuedAtRaw) return null;

    await this.redis.del(key); // single-use: burn the challenge either way

    const elapsedMs = Date.now() - Number(issuedAtRaw);
    if (elapsedMs < MIN_INTERACTION_MS) return null;

    const token = randomUUID();
    await this.redis.set(
      RedisKeys.captchaVerified(token),
      '1',
      RedisTtl.captchaVerified,
    );
    return { token, expiresIn: RedisTtl.captchaVerified };
  }

  /** Checks and consumes a pass. Succeeds at most once per completed slide. */
  async consumePass(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    const key = RedisKeys.captchaVerified(token);
    if (!(await this.redis.exists(key))) return false;
    await this.redis.del(key);
    return true;
  }
}
