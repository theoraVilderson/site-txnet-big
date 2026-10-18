import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey, TenantCapability, ZodValidationPipe } from '@txnet-backend/shared-core';
import { Request } from 'express';
import { AuthGuard } from '../auth.guard';
import { RateLimit, type RateLimitOptions } from '../decorators/rate-limit.decorator';
import { SensitiveActionGuard } from '../../impersonation/guards/sensitive-action.guard';
import { terminateSessionSchema } from '../auth.schema';
import type { AuthClaims } from '../token.service';
import { ActiveSessionsService } from './active-sessions.service';

const LIMIT: RateLimitOptions = {
  key: (req) => rateLimitBucketKey(RateLimitBucket.ME_SESSIONS, req?.user?.sub ?? req?.ip),
  configKey: 'ME_SESSIONS_RATE_LIMIT',
  windowSec: 900,
};

/**
 * The caller's own active sessions (SES-1-a, `auth-api/contract.sessions.md`):
 * every place the account is signed in, and ending the others.
 *
 * The two writes are `signOut`, which no tenant status refuses — a closed
 * tenant's user must still be able to throw a thief out. Neither is open to
 * an admin impersonating the account: ending someone's sessions is theirs.
 */
@Controller('auth/sessions')
export class ActiveSessionsController {
  constructor(private readonly sessions: ActiveSessionsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @RateLimit(LIMIT)
  list(@Req() req: Request) {
    return this.sessions.list(claimsOf(req));
  }

  @TenantCapability('signOut')
  @Post('terminate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard, SensitiveActionGuard)
  @RateLimit(LIMIT)
  terminate(@Body(new ZodValidationPipe(terminateSessionSchema)) body: { id: string }, @Req() req: Request) {
    return this.sessions.terminate(claimsOf(req), body.id);
  }

  @TenantCapability('signOut')
  @Post('terminate-others')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard, SensitiveActionGuard)
  @RateLimit(LIMIT)
  terminateOthers(@Req() req: Request) {
    return this.sessions.terminateOthers(claimsOf(req));
  }
}

function claimsOf(req: Request): AuthClaims {
  return (req as unknown as { user: AuthClaims }).user;
}
