import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys, RedisTtl } from '../../redis/redis.keys';
import { normalizePhone } from '../../common/validation/phone.schema';

/** The steps whose code "Resend code" replays (F-0201-f). */
export const RESEND_STEPS = ['login', 'register', 'forgot'] as const;
export type ResendStep = (typeof RESEND_STEPS)[number];

/** How many resends one captcha buys; the OTP service's cooldown and per-number cap still apply to each. */
export const RESEND_MAX_USES = 3;

/** Spends one use of a live grant; INCR keeps the TTL `grant` set. 1 when a use was left. */
const SPEND = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('INCR', KEYS[1]) > tonumber(ARGV[1]) then return 0 end
return 1`;

/**
 * Resend grants (F-0201-f): a step that sent a code writes one after its
 * captcha passed — for any number, so the grant says nothing about an account —
 * and a resend spends a use instead of asking for another slide.
 */
@Injectable()
export class OtpResendGrants {
  constructor(private readonly redis: RedisService) {}

  /** A fresh grant for (tenant, step, phone), replacing any earlier one. */
  grant(step: ResendStep, phone: string): Promise<void> {
    return this.redis.set(RedisKeys.otpResend(step, normalizePhone(phone)), '0', RedisTtl.otpResend);
  }

  /** True when the grant was live and had a use left. */
  async spend(step: ResendStep, phone: string): Promise<boolean> {
    return (await this.redis.evalScript<number>(SPEND, [RedisKeys.otpResend(step, normalizePhone(phone))], [RESEND_MAX_USES])) === 1;
  }
}
