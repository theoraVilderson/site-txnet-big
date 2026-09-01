import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys, RedisTtl } from '../../redis/redis.keys';
import { OtpPurpose } from './otp.interface';

// Atomically read the stored OTP, bump the attempt counter (keeping the
// original TTL), and hand back the hash for the caller to compare. After 5
// attempts the record is destroyed.
//   returns { status, previousAttemptCount, codeHash }
//   status:  0 = not found, -1 = attempts exhausted, 1 = ok
const VERIFY_SCRIPT = `
  local key = KEYS[1]
  local raw = redis.call('GET', key)
  if not raw then
    return {0, -1, ''}
  end
  local payload = cjson.decode(raw)
  local codeHash = payload.codeHash
  local attemptCount = tonumber(payload.attemptCount or 0)
  if attemptCount >= 5 then
    redis.call('DEL', key)
    return {-1, attemptCount, ''}
  end
  payload.attemptCount = attemptCount + 1
  redis.call('SET', key, cjson.encode(payload), 'KEEPTTL')
  return {1, attemptCount, codeHash}
`;

export type OtpVerificationPeek =
  | { status: 'missing' }
  | { status: 'exhausted' }
  | { status: 'pending'; codeHash: string };

/**
 * Owns the OTP keyspace in Redis: the hashed code + attempt counter, the
 * issue-time idempotency lock, and the request cooldown. Redis is the source
 * of truth for OTP state; Postgres only keeps an audit trail.
 */
@Injectable()
export class OtpStore {
  constructor(private readonly redis: RedisService) {}

  acquireLock(phone: string, purpose: OtpPurpose): Promise<boolean> {
    return this.redis.setNx(
      RedisKeys.otpLock(purpose, phone),
      '1',
      RedisTtl.otpLock,
    );
  }

  releaseLock(phone: string, purpose: OtpPurpose): Promise<void> {
    return this.redis.del(RedisKeys.otpLock(purpose, phone));
  }

  isCoolingDown(phone: string, purpose: OtpPurpose): Promise<boolean> {
    return this.redis.exists(RedisKeys.otpCooldown(purpose, phone));
  }

  startCooldown(phone: string, purpose: OtpPurpose): Promise<void> {
    return this.redis.set(
      RedisKeys.otpCooldown(purpose, phone),
      '1',
      RedisTtl.otpCooldown,
    );
  }

  save(phone: string, purpose: OtpPurpose, codeHash: string): Promise<void> {
    return this.redis.setJson(
      RedisKeys.otpCode(purpose, phone),
      { codeHash, attemptCount: 0 },
      RedisTtl.otpCode,
    );
  }

  /** Consume one verification attempt; the caller compares the returned hash. */
  async peekForVerification(
    phone: string,
    purpose: OtpPurpose,
  ): Promise<OtpVerificationPeek> {
    const [status, , codeHash] = await this.redis.evalScript<
      [number, number, string]
    >(VERIFY_SCRIPT, [RedisKeys.otpCode(purpose, phone)], []);

    if (status === 0) return { status: 'missing' };
    if (status === -1) return { status: 'exhausted' };
    return { status: 'pending', codeHash };
  }

  clear(phone: string, purpose: OtpPurpose): Promise<void> {
    return this.redis.del(RedisKeys.otpCode(purpose, phone));
  }
}
