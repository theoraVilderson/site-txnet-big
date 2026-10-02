import { Controller, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ok, RateLimitBucket, rateLimitBucketKey, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { MySuggestionService, type MySuggestions } from './my-suggestion';

/**
 * The panel's suggestion card (F-038-h) — ai-service's first route reached
 * through Traefik (user, 2026-10-02), behind `my-auth`. Whose suggestion it is
 * comes from `X-User-Id` and the tenant from `X-Tenant-Id`, both off the gate;
 * no route takes a user. The writes are the user's own account: open while a
 * reseller is suspended (F-018-p), as the inbox's are.
 */
@Controller('api/ai/me/suggestion')
export class MySuggestionController {
  constructor(@Inject(MySuggestionService) private readonly suggestions: MySuggestions) {}

  @Get()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.AI_SUGGESTION_READ, identityOf(req).userId),
    configKey: 'AI_SUGGESTION_READ_RATE_LIMIT',
    windowSec: 900,
  })
  async current(@Req() req: Request) {
    const { tenantId, userId } = identityOf(req);
    return ok({ suggestion: await this.suggestions.current(tenantId, userId, new Date()) });
  }

  @Post(':actionId/dismiss')
  @HttpCode(200)
  @TenantCapability('account')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.AI_SUGGESTION_WRITE, identityOf(req).userId),
    configKey: 'AI_SUGGESTION_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  async dismiss(@Param('actionId', new ParseUUIDPipe()) actionId: string, @Req() req: Request) {
    const { tenantId, userId } = identityOf(req);
    const done = await this.suggestions.dismiss(tenantId, userId, actionId, new Date());
    if (!done) throw new NotFoundException();
    return ok(done);
  }

  @Post(':actionId/opt-out')
  @HttpCode(200)
  @TenantCapability('account')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.AI_SUGGESTION_WRITE, identityOf(req).userId),
    configKey: 'AI_SUGGESTION_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  async optOut(@Param('actionId', new ParseUUIDPipe()) actionId: string, @Req() req: Request) {
    const { tenantId, userId } = identityOf(req);
    const done = await this.suggestions.optOut(tenantId, userId, actionId, new Date());
    if (!done) throw new NotFoundException();
    return ok(done);
  }
}
