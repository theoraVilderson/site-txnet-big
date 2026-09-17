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
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Language } from '@prisma/client';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import {
  ListCampaignsQuery,
  campaignTextLangSchema,
  campaignTextSchema,
  createCampaignSchema,
  listCampaignsSchema,
  updateCampaignSchema,
} from './campaign-admin.schema';
import {
  CampaignActor,
  CampaignAdminRefused,
  CampaignAdminRejection,
  CampaignAdminService,
  CreateCampaignInput,
  UpdateCampaignInput,
} from './campaign-admin.service';
import { CampaignPermissionGuard } from './campaign-permission.guard';
import { CampaignTextService } from './campaign-texts';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
export const CAMPAIGN_REFUSAL_STATUS: Record<CampaignAdminRejection, 400 | 403 | 404 | 409> = {
  not_platform_owner: 403,
  tenant_not_found: 404,
  campaign_not_found: 404,
  campaign_not_draft: 409,
  sms_not_available: 409,
  email_not_available: 409,
  text_is_source: 400,
  text_not_found: 404,
};

const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.NOTIFICATION_CAMPAIGN_READ, identityOf(req).userId),
  configKey: 'NOTIFICATION_CAMPAIGN_READ_RATE_LIMIT' as const,
  windowSec: 900,
};
const WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.NOTIFICATION_CAMPAIGN_WRITE, identityOf(req).userId),
  configKey: 'NOTIFICATION_CAMPAIGN_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * Campaign drafts (F-035-c): `/api/notifications/campaigns`, inside the gated
 * router the inbox already has. One surface for the platform owner and tenant
 * admins, told apart by the tenant, never by the path.
 *
 * Bodies are typed as the service's inputs, not `z.infer`, for the reason
 * `notification-internal.controller.ts` gives; the pipe guarantees them.
 */
@Controller('notifications/campaigns')
@UseGuards(CampaignPermissionGuard)
export class CampaignAdminController {
  constructor(
    private readonly campaigns: CampaignAdminService,
    private readonly texts: CampaignTextService,
  ) {}

  private actor(req: Request): CampaignActor {
    const { userId, tenantId } = identityOf(req);
    return { adminId: userId, tenantId };
  }

  @Get()
  @RateLimit(READ)
  list(@Query(new ZodValidationPipe(listCampaignsSchema)) query: ListCampaignsQuery, @Req() req: Request) {
    return this.refusing(() => this.campaigns.list(this.actor(req), query));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  create(@Body(new ZodValidationPipe(createCampaignSchema)) body: CreateCampaignInput, @Req() req: Request) {
    return this.refusing(() => this.campaigns.create(this.actor(req), body));
  }

  @Get(':id')
  @RateLimit(READ)
  get(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.refusing(() => this.campaigns.get(this.actor(req), id));
  }

  @Patch(':id')
  @RateLimit(WRITE)
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateCampaignSchema)) body: UpdateCampaignInput,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.campaigns.update(this.actor(req), id, body));
  }

  /** Starts the send (F-035-d); audited. The fan-out runs on `worker-service`. */
  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  send(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.campaigns.send(this.actor(req), id, ip));
  }

  /** The campaign in every language (F-035-h): the source, each text, and the languages with none. */
  @Get(':id/texts')
  @RateLimit(READ)
  listTexts(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.refusing(() => this.texts.list(this.actor(req), id));
  }

  /** Machine drafts for every language with no text; published by an admin, never sent as drafts. */
  @Post(':id/texts/draft')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  draftTexts(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.refusing(() => this.texts.draftMissing(this.actor(req), id));
  }

  @Put(':id/texts/:lang')
  @RateLimit(WRITE)
  writeText(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('lang', new ZodValidationPipe(campaignTextLangSchema)) lang: Language,
    @Body(new ZodValidationPipe(campaignTextSchema)) body: { subject?: string | null; body: string },
    @Req() req: Request,
  ) {
    return this.refusing(() => this.texts.write(this.actor(req), id, lang, body));
  }

  @Post(':id/texts/:lang/publish')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  publishText(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('lang', new ZodValidationPipe(campaignTextLangSchema)) lang: Language,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.texts.publish(this.actor(req), id, lang));
  }

  /** One place that turns a refusal into a status; the reason travels in the body for the panel to translate. */
  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof CampaignAdminRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (CAMPAIGN_REFUSAL_STATUS[e.reason]) {
        case 403:
          throw new ForbiddenException(payload);
        case 404:
          throw new NotFoundException(payload);
        case 409:
          throw new ConflictException(payload);
        default:
          throw new BadRequestException(payload);
      }
    }
  }
}
