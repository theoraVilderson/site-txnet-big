import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { RateLimitBucket, ServiceOnlyGuard, TenantCapability, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { SupportManageGuard } from '../availability/support-manage.guard';
import { callerOf, refusing } from '../conversations/conversations.controller';
import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { LifecyclePolicy, RatingView, SupportLifecycle } from './lifecycle';
import { LifecycleBody, RatingBody, lifecycleSchema, ratingSchema } from './lifecycle.schema';

const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SUPPORT_READ, identityOf(req).userId),
  configKey: 'SUPPORT_READ_RATE_LIMIT' as const,
  windowSec: 60,
};

const WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SUPPORT_SEND, identityOf(req).userId),
  configKey: 'SUPPORT_SEND_RATE_LIMIT' as const,
  windowSec: 60,
};

/** The user's half (F-033-k): rate a finished thread, reopen a closed one. Their own threads only. */
@Controller('support/conversations')
export class SupportLifecycleController {
  constructor(private readonly lifecycle: SupportLifecycle) {}

  @Post(':id/rating')
  @HttpCode(200)
  @RateLimit(WRITE)
  rate(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(ratingSchema)) body: RatingBody): Promise<RatingView> {
    return refusing(() => this.lifecycle.rate(callerOf(req), id, body));
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RateLimit(WRITE)
  reopen(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string) {
    return refusing(() => this.lifecycle.reopen(callerOf(req), id));
  }
}

/** A tenant's auto-close and reopen days (F-033-k). `support.manage`. */
@Controller('support/settings/lifecycle')
@UseGuards(SupportManageGuard)
export class SupportLifecycleSettingsController {
  constructor(private readonly lifecycle: SupportLifecycle) {}

  @Get()
  @RateLimit(READ)
  policy(@Req() req: Request): Promise<LifecyclePolicy> {
    return this.lifecycle.policy(callerOf(req).tenantId);
  }

  @Put()
  @RateLimit(WRITE)
  setPolicy(@Req() req: Request, @Body(new ZodValidationPipe(lifecycleSchema)) body: LifecycleBody): Promise<LifecyclePolicy> {
    return refusing(() => this.lifecycle.setPolicy(callerOf(req).tenantId, body));
  }
}

/**
 * The idle sweep's door (F-033-k): worker-service's `support_auto_close` job,
 * with `SERVICE_AUTH_TOKEN` (ADR-0011). Not routed by Traefik; a wrong token is
 * a 404. Crosses every tenant, so it carries none (`'system'`).
 */
@TenantCapability('system')
@Controller('internal/support')
@UseGuards(ServiceOnlyGuard)
export class SupportLifecycleInternalController {
  constructor(private readonly lifecycle: SupportLifecycle) {}

  @Post('close-idle')
  @HttpCode(200)
  closeIdle(): Promise<{ scanned: number; closed: number }> {
    return this.lifecycle.closeIdle();
  }
}
