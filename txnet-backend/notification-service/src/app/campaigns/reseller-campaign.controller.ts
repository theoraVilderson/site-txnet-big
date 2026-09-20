import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import type { AudienceFilter } from './campaign-admin.schema';
import { CreateCampaignInput } from './campaign-admin.service';
import {
  ResellerListCampaignsQuery,
  audienceCountSchema,
  resellerCreateCampaignSchema,
  resellerListCampaignsSchema,
} from './reseller-campaign.schema';
import {
  ResellerCampaignRefused,
  ResellerCampaignRejection,
  ResellerCampaignService,
} from './reseller-campaign.service';

/**
 * Every refusal of this surface gets a status; a new reason on either door does
 * not compile until it gets one (C-09's habit). The campaign reasons below the
 * line cannot be reached from here — this surface has no texts, no resume and
 * no platform-wide scope — but they are part of the type, and listing them is
 * what makes a future route that *does* reach one a compile-time question
 * rather than a 500.
 */
export const RESELLER_CAMPAIGN_STATUS: Record<ResellerCampaignRejection, 400 | 403 | 404 | 409> = {
  // The door (F-066-w1, tenant invariant 21).
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  // The campaign rules behind it (F-035-c/d).
  campaign_not_found: 404,
  campaign_not_draft: 409,
  sms_not_available: 409,
  email_not_available: 409,
  tenant_not_found: 404,
  not_platform_owner: 403,
  text_is_source: 400,
  text_not_found: 404,
  campaign_not_stopped: 409,
  tenant_not_open: 409,
};

const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_CAMPAIGN_READ, identityOf(req).userId),
  configKey: 'RESELLER_CAMPAIGN_READ_RATE_LIMIT' as const,
  windowSec: 900,
};
const WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_CAMPAIGN_WRITE, identityOf(req).userId),
  configKey: 'RESELLER_CAMPAIGN_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * A named reseller's own campaigns (F-313-d, spec F-313):
 * `/api/notifications/tenants/:tenantId/campaigns…` — the door the bot's bulk
 * send flow (F-313-b) calls, and a reseller panel page after it.
 *
 * **No permission guard**, unlike `CampaignAdminController`: `campaign.manage`
 * is the platform staff's door, and a reseller's owner is the platform's
 * customer, holding no operator permission. `ResellerAccess` is the door here,
 * applied inside the service together with the scope the work then runs in —
 * the same shape as billing's `ResellerRevenueController` (F-311-b).
 *
 * **The tenant is the path's.** The owner signs in to the platform owner's
 * tenant (ADR-0059 (6)), so the session's `X-Tenant-Id` names the platform;
 * every shape here is `.strict()` and carries no `tenantId`, so no request can
 * offer a second answer to a question the path has already answered.
 */
@Controller('notifications/tenants/:tenantId/campaigns')
export class ResellerCampaignController {
  constructor(private readonly campaigns: ResellerCampaignService) {}

  private actor(req: Request) {
    const { userId, tenantId, permissions } = identityOf(req);
    return { userId, tenantId, permissions };
  }

  @Get()
  @RateLimit(READ)
  list(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query(new ZodValidationPipe(resellerListCampaignsSchema)) query: ResellerListCampaignsQuery,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.campaigns.list(this.actor(req), tenantId, query));
  }

  /**
   * How many users a segment reaches, before anything is drafted (F-313-b's
   * "see the count"). A `POST` because the audience is a nested object, and
   * `HttpCode(OK)` because it creates nothing. Declared before `:id`'s routes
   * so the literal wins, the precedent `sending-summary/:tenantId` set.
   */
  @Post('audience/count')
  @HttpCode(HttpStatus.OK)
  @RateLimit(READ)
  count(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(audienceCountSchema)) body: { audience: AudienceFilter },
    @Req() req: Request,
  ) {
    return this.refusing(() => this.campaigns.audienceCount(this.actor(req), tenantId, body.audience));
  }

  @Post()
  @RateLimit(WRITE)
  create(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(resellerCreateCampaignSchema)) body: Omit<CreateCampaignInput, 'tenantId'>,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.campaigns.create(this.actor(req), tenantId, body));
  }

  @Get(':id')
  @RateLimit(READ)
  get(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.campaigns.get(this.actor(req), tenantId, id));
  }

  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  send(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.campaigns.send(this.actor(req), tenantId, id, ip));
  }

  /** One refusal type, one table, one place that turns it into a status. */
  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (!(e instanceof ResellerCampaignRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (RESELLER_CAMPAIGN_STATUS[e.reason]) {
        case 400:
          throw new BadRequestException(payload);
        case 403:
          throw new ForbiddenException(payload);
        case 404:
          throw new NotFoundException(payload);
        default:
          throw new ConflictException(payload);
      }
    }
  }
}
