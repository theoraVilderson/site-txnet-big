import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Re-exported, not re-declared. The name is owned by
 * `contracts/http/wire.json` and imported from `shared-core` (ADR-0036, C-04)
 * — `bot-service` declared its own copy of this same string, which is the
 * shape that drifts. The alias stays because every call site in this service
 * already reads well with it.
 */
export const SERVICE_TOKEN_HEADER = RequestHeaders.serviceToken;
/** Which chat a bot-originated call is acting for — the rate-limit subject. */
export const BOT_CHAT_HEADER = RequestHeaders.botChatId;

/**
 * Marks a request as coming from another service of this platform
 * (`bot-service`, today) rather than from a browser.
 *
 * Why this exists (ADR-0011): the bot cannot solve a slide captcha, and every
 * call it makes arrives from one IP, so the two controls that protect these
 * routes for a browser are respectively impossible and actively harmful for a
 * bot — the per-IP bucket would lock out the whole bot on the tenth user of the
 * hour.
 *
 * What a valid token buys, and nothing more:
 *   1. `CaptchaGuard` is satisfied (F-0201),
 *   2. the rate-limit subject becomes the chat id instead of the IP.
 *
 * It is **not** an authentication: it says which *process* is calling, never
 * which user. Every route still proves the user exactly as it does for the
 * panel — a phone number still needs its OTP, a password still needs to match.
 */
@Injectable()
export class ServiceCallerMiddleware implements NestMiddleware {
  private readonly expected?: string;

  constructor(config: ConfigService) {
    this.expected = config.get<string>('SERVICE_AUTH_TOKEN');
  }

  use(req: Request, _res: Response, next: NextFunction) {
    const given = req.headers[SERVICE_TOKEN_HEADER];
    const isService =
      typeof given === 'string' && this.matches(given);

    (req as any).serviceCaller = isService;

    const chatId = req.headers[BOT_CHAT_HEADER];
    (req as any).rateSubject =
      isService && typeof chatId === 'string' && chatId
        ? `bot:${chatId}`
        : req.ip;

    next();
  }

  private matches(given: string): boolean {
    if (!this.expected) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

/** True only for a call carrying a valid `SERVICE_AUTH_TOKEN`. */
export function isServiceCaller(req: unknown): boolean {
  return (req as { serviceCaller?: boolean })?.serviceCaller === true;
}

/**
 * Who a per-caller rate limit counts against **within one tenant**: the acting
 * chat for a bot call, the IP for everyone else. Prefer it to writing `req.ip`
 * directly — that is what makes one bot look like one attacker.
 *
 * It deliberately says nothing about the tenant (F-1206). A chat id is the
 * messenger's and an IP is the internet's, so both are the same value at two
 * resellers' front doors; the tenant segment is added once, by
 * `RedisKeys.rateLimit`, so that the two captcha routes and
 * `login-failures:<identity>` — none of which call this — are scoped too.
 */
export function rateLimitSubject(req: unknown): string {
  const r = req as { rateSubject?: string; ip?: string };
  return r?.rateSubject ?? r?.ip ?? 'unknown';
}
