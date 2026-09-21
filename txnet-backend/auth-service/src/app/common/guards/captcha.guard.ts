import {
  RateLimitBucket,
  RequestHeaders,
  headerValue,
  rateLimitBucketKey,
} from '@txnet-backend/shared-core';
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { REQUIRE_CAPTCHA_KEY } from '../../auth/decorators/require-captcha.decorator';
import { CaptchaService } from '../../auth/captcha/captcha.service';
import { isServiceCaller, rateLimitSubject } from '../security/service-caller';
import { RateLimiter } from '../rate-limit/rate-limiter';

/**
 * The window the per-chat bot ceiling is counted over. At its call site, like
 * every other rate-limit window (`auth-api/contract.rate-limits.md`).
 */
const BOT_UNPROVEN_WINDOW_SEC = 900;

@Injectable()
export class CaptchaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly captcha: CaptchaService,
    private readonly rateLimiter: RateLimiter,
    private readonly config: ConfigService,
  ) {}

  /**
   * What stands in for the slide a bot cannot drag (F-0201-c, F-0201-e).
   *
   * ADR-0011 waives the captcha for a proven service caller and states the cost
   * plainly: "the rate limits, not the captcha, are then the only thing between
   * an attacker and these routes". This is the limit that answers it — one
   * budget for **this chat's** unproven traffic, over exactly the routes the
   * waiver applies to and no others.
   *
   * Its subject is the acting chat, like every other counter a bot call meets
   * (`rateLimitSubject`). ADR-0069 shipped it keyed on the tenant instead, to
   * price the breadth of an attacker who buys messenger accounts; ADR-0070
   * reversed that on the user's call, because a budget shared across a
   * reseller's whole bot is a budget one attacker can spend, and the customer
   * it then refuses is never the one who spent it. A per-chat subject cannot be
   * exhausted by anybody but its own chat, so no legitimate sign-in is ever
   * refused for somebody else's traffic — and the cost of dropping the breadth
   * ceiling is written down in ADR-0070.
   *
   * It is a cross-route aggregate, which is what it adds over the per-route
   * limits already on each gated route: those bound one chat on one route, this
   * bounds one chat across every route the captcha was waived on.
   *
   * A signed-in chat never spends it at all: the bot's fast path answers from
   * `POST /auth/bots/session` (ADR-0012), which is not gated. So this counts
   * sign-ins, registrations and resets *started* in a chat, not a customer's
   * ordinary use.
   */
  private async assertBotTrafficHasRoom(request: unknown): Promise<void> {
    const { allowed } = await this.rateLimiter.hit(
      rateLimitBucketKey(RateLimitBucket.BOT_UNPROVEN, rateLimitSubject(request)),
      this.config.get<number>('BOT_UNPROVEN_RATE_LIMIT')!,
      BOT_UNPROVEN_WINDOW_SEC,
    );
    if (!allowed) {
      // `reason` is how the bot tells this refusal from a wrong password
      // without reading a status code (ADR-0043, and ADR-0009's rule that
      // `AuthApiClient` reads answers rather than HTTP). It is what turns the
      // refusal into an offer: the Mini App is a browser, so it can carry the
      // slide this chat cannot.
      throw new HttpException(
        { i18nKey: 'auth.temporarilyLocked', reason: 'botTrafficThrottled' },
        429,
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_CAPTCHA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const request = context.switchToHttp().getRequest();

    // A bot cannot drag a slider. Another service of this platform, proven by
    // `SERVICE_AUTH_TOKEN`, stands in for the bot check — its own per-chat rate
    // limits are what carry the load instead (ADR-0011) — plus one ceiling over
    // this chat's unproven traffic across every route the waiver covers.
    if (isServiceCaller(request)) {
      await this.assertBotTrafficHasRoom(request);
      return true;
    }

    const token = headerValue(request.headers, RequestHeaders.captchaToken);
    const passed = await this.captcha.consumePass(
      typeof token === 'string' ? token : undefined,
    );
    if (!passed) {
      throw new HttpException({ i18nKey: 'captcha.required' }, 400);
    }
    return true;
  }
}
