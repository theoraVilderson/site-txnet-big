import { Controller, Get, HttpCode, HttpStatus, Req, UseGuards } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import { Request } from 'express';
import { AuthGuard } from '../auth.guard';
import { RateLimit } from '../decorators/rate-limit.decorator';
import { MeService } from './me.service';
import type { AuthClaims } from '../token.service';

/**
 * `GET /api/auth/me` — the caller's own identity and authority (F-097).
 *
 * Under `/auth` rather than a prefix of its own for the reason F-098 gives: the
 * path names the service that hosts the route, never the kind of person calling
 * it. Behind `AuthGuard` and deliberately not behind `NoActiveSessionGuard` — a
 * live session is this route's premise, not an obstacle to it (C-21).
 *
 * Keyed per caller rather than per IP, like every other authenticated read
 * here: the caller is known, and an IP key would let one account spend a shared
 * NAT's budget for everyone behind it.
 */
@Controller('auth')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ME, req?.user?.sub ?? req?.ip),
    configKey: 'ME_RATE_LIMIT',
    windowSec: 900,
  })
  describe(@Req() req: Request) {
    return this.me.describe((req as unknown as { user: AuthClaims }).user);
  }
}
