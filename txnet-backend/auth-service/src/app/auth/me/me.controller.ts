import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import { Request } from 'express';
import { AuthGuard } from '../auth.guard';
import { RateLimit } from '../decorators/rate-limit.decorator';
import { MeService } from './me.service';
import { MeEmailService } from './me-email.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { meEmailRequestSchema, meEmailVerifySchema } from '../auth.schema';
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
  constructor(
    private readonly me: MeService,
    private readonly email: MeEmailService,
  ) {}

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ME, req?.user?.sub ?? req?.ip),
    configKey: 'ME_RATE_LIMIT',
    windowSec: 900,
  })
  describe(@Req() req: Request) {
    return this.me.describe(claimsOf(req));
  }

  /**
   * Mail a code to an address the caller wants on their account (F-035-g).
   * 202 with delivery handles, as every code is (F-067-a); the address is not
   * written until `me/email/verify`.
   */
  @Post('me/email')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(AuthGuard)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ME_EMAIL_REQUEST, req?.user?.sub ?? req?.ip),
    configKey: 'ME_EMAIL_REQUEST_RATE_LIMIT',
    windowSec: 900,
  })
  requestEmailCode(
    @Body(new ZodValidationPipe(meEmailRequestSchema)) body: { email: string },
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    return this.email.requestCode(claimsOf(req), body.email, ip, langOf(req));
  }

  /** Confirm the code; only now does `user.email` change. */
  @Post('me/email/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.ME_EMAIL_VERIFY, req?.user?.sub ?? req?.ip),
    configKey: 'ME_EMAIL_VERIFY_RATE_LIMIT',
    windowSec: 900,
  })
  verifyEmail(
    @Body(new ZodValidationPipe(meEmailVerifySchema))
    body: { email: string; otpCode: string },
    @Req() req: Request,
  ) {
    return this.email.confirm(claimsOf(req), body.email, body.otpCode);
  }
}

function claimsOf(req: Request): AuthClaims {
  return (req as unknown as { user: AuthClaims }).user;
}

function langOf(req: Request): string {
  return (req as unknown as { language?: string }).language ?? 'fa';
}
