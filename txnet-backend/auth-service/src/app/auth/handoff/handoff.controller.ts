import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey, TenantCapability } from '@txnet-backend/shared-core';
import { Request, Response } from 'express';
import { AuthGuard } from '../auth.guard';
import { NoActiveSessionGuard } from '../guards/no-active-session.guard';
import { RateLimit } from '../decorators/rate-limit.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { rateLimitSubject } from '../../common/security/service-caller';
import { withRefreshCookie } from '../../common/http/refresh-cookie';
import { resolveSwitchScope } from '../../common/security/switch-scope';
import { handoffIssueSchema, handoffRedeemSchema } from '../auth.schema';
import type { AuthClaims } from '../token.service';
import { HandoffService } from './handoff.service';

/**
 * `/api/auth/handoff` — the "my reseller panel" button (F-061-f, ADR-0059).
 *
 * The list and the mint run on the platform's panel with the owner's session;
 * the redeem runs on the reseller's panel domain, before any session there, and
 * answers exactly what a password sign-in answers: the access token in the
 * body, the refresh token as the host-only cookie (ADR-0060 (4)).
 */
@TenantCapability('signIn')
@Controller('auth/handoff')
export class HandoffController {
  constructor(private readonly handoff: HandoffService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.HANDOFF_LIST, req?.user?.sub ?? req?.ip),
    configKey: 'HANDOFF_LIST_RATE_LIMIT',
    windowSec: 900,
  })
  owned(@Req() req: Request) {
    return this.handoff.owned(claimsOf(req));
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.HANDOFF_ISSUE, req?.user?.sub ?? req?.ip),
    configKey: 'HANDOFF_ISSUE_RATE_LIMIT',
    windowSec: 900,
  })
  issue(@Req() req: Request, @Body(new ZodValidationPipe(handoffIssueSchema)) body: { tenantId: string }) {
    return this.handoff.issue(claimsOf(req), body.tenantId);
  }

  @Post('redeem')
  @HttpCode(HttpStatus.OK)
  @UseGuards(NoActiveSessionGuard)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.HANDOFF_REDEEM, rateLimitSubject(req)),
    configKey: 'HANDOFF_REDEEM_RATE_LIMIT',
    windowSec: 900,
  })
  async redeem(
    @Body(new ZodValidationPipe(handoffRedeemSchema)) body: { code: string },
    @Ip() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.handoff.redeem(
      body.code,
      ip,
      req.get('user-agent') ?? 'unknown',
      resolveSwitchScope(req),
    );
    return withRefreshCookie(res, result);
  }
}

function claimsOf(req: Request): AuthClaims {
  return (req as unknown as { user: AuthClaims }).user;
}
