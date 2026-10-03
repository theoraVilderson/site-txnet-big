import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { SupportAgentGuard } from '../agent/support-agent.guard';
import { SupportManageGuard } from '../availability/support-manage.guard';
import { callerOf, languageOf, refusing } from '../conversations/conversations.controller';
import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { CannedPick, CannedView, SupportCannedReplies } from './canned';
import { CreateCannedBody, UpdateCannedBody, createCannedSchema, updateCannedSchema } from './canned.schema';

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

/** Inserting a canned reply (F-033-j): `support.agent`, the caller's tenant only. */
@Controller('support/agent')
@UseGuards(SupportAgentGuard)
export class SupportCannedAgentController {
  constructor(private readonly canned: SupportCannedReplies) {}

  /** The picker, labelled in the agent's language. */
  @Get('canned-replies')
  @RateLimit(READ)
  picker(@Req() req: Request): Promise<CannedPick[]> {
    return this.canned.picker(callerOf(req), languageOf(req));
  }

  /** One reply filled for this conversation, in its user's language — text to put in the reply box, nothing stored. */
  @Get('conversations/:id/canned-replies/:replyId')
  @RateLimit(READ)
  render(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('replyId', new ParseUUIDPipe()) replyId: string,
  ) {
    return refusing(() => this.canned.render(callerOf(req), id, replyId));
  }
}

/** A tenant's own canned replies (F-033-j): `support.manage`. The platform's defaults are read-only to it. */
@Controller('support/settings/canned-replies')
@UseGuards(SupportManageGuard)
export class SupportCannedSettingsController {
  constructor(private readonly canned: SupportCannedReplies) {}

  @Get()
  @RateLimit(READ)
  own(@Req() req: Request): Promise<CannedView[]> {
    return this.canned.own(callerOf(req).tenantId);
  }

  @Post()
  @RateLimit(WRITE)
  create(@Req() req: Request, @Body(new ZodValidationPipe(createCannedSchema)) body: CreateCannedBody): Promise<CannedView> {
    return refusing(() => this.canned.create(callerOf(req).tenantId, body));
  }

  @Patch(':id')
  @RateLimit(WRITE)
  update(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateCannedSchema)) body: UpdateCannedBody,
  ): Promise<CannedView> {
    return refusing(() => this.canned.update(callerOf(req).tenantId, id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @RateLimit(WRITE)
  async remove(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await refusing(() => this.canned.remove(callerOf(req).tenantId, id));
  }
}
