import {
  RateLimitBucket,
  RequestHeaders,
  headerValue,
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
import { isServiceCaller } from '../security/service-caller';
import { RateLimiter } from '../rate-limit/rate-limiter';

/**
 * The window the tenant-wide bot ceiling is counted over. At its call site,
 * like every other rate-limit window (`auth-api/contract.rate-limits.md`).
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
   * What stands in for the slide a bot cannot drag (F-0201-c).
   *
   * ADR-0011 waives the captcha for a proven service caller and states the cost
   * plainly: "the rate limits, not the captcha, are then the only thing between
   * an attacker and these routes". Every one of those limits is per chat, and a
   * chat is a messenger account — so the exemption was priced at whatever a
   * Telegram account costs, times as many as somebody cares to register.
   *
   * This is one budget for the tenant's **unproven** bot traffic, over exactly
   * the routes the waiver applies to and no others. The routes are the filter,
   * which is why no lookup is needed to tell a stranger's chat from a
   * customer's: a signed-in chat never calls them at all — the bot's fast path
   * answers from `POST /auth/bots/session` (ADR-0012), which is not gated. So a
   * reseller's real users do not spend this, and fifty fresh chats share one
   * budget instead of bringing fifty of their own.
   *
   * Per tenant, never platform-wide: one reseller's attacker must not be able
   * to shut every other reseller's bot sign-in.
   */
  private async assertBotTrafficHasRoom(): Promise<void> {
    const { allowed } = await this.rateLimiter.hit(
      RateLimitBucket.BOT_UNPROVEN,
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
    // limits are what carry the load instead (ADR-0011) — plus, since
    // 2026-09-21, one ceiling over the whole tenant's unproven bot traffic,
    // because a per-chat limit is bought again with another messenger account.
    if (isServiceCaller(request)) {
      await this.assertBotTrafficHasRoom();
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
