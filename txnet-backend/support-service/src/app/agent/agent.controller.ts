import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { SupportAvailability } from '../availability/availability';
import { PresenceBody, presenceSchema } from '../availability/availability.schema';
import { MessagesQuery, ReadBody, messagesQuerySchema, readSchema } from '../conversations/conversations.schema';
import { callerOf, refusing } from '../conversations/conversations.controller';
import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { AssignBody, InboxQuery, ReplyBody, assignSchema, inboxQuerySchema, replySchema } from './agent.schema';
import { AgentConversationView, AgentMessagePage, AgentMessageView, SupportAgentService } from './agent.service';
import { SupportAgentGuard } from './support-agent.guard';

// The user side's buckets, keyed by the agent's own id: one person, one budget.
const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SUPPORT_READ, identityOf(req).userId),
  configKey: 'SUPPORT_READ_RATE_LIMIT' as const,
  windowSec: 60,
};

const SEND = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SUPPORT_SEND, identityOf(req).userId),
  configKey: 'SUPPORT_SEND_RATE_LIMIT' as const,
  windowSec: 60,
};

const TYPING = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SUPPORT_TYPING, identityOf(req).userId),
  configKey: 'SUPPORT_TYPING_RATE_LIMIT' as const,
  windowSec: 60,
};

/** The agent's side of support (F-033-d, catalog §11.3). `support.agent`, the caller's tenant only. */
@Controller('support/agent')
@UseGuards(SupportAgentGuard)
export class SupportAgentController {
  constructor(
    private readonly agents: SupportAgentService,
    private readonly availability: SupportAvailability,
  ) {}

  /** The agent's heartbeat (F-033-g): `online` every 30s while the panel is open, `away` on leaving. */
  @Post('presence')
  @HttpCode(200)
  @RateLimit(TYPING)
  presence(@Req() req: Request, @Body(new ZodValidationPipe(presenceSchema)) body: PresenceBody) {
    return this.availability.beat(callerOf(req), body.status);
  }

  /** Who of the tenant's agents is online now. */
  @Get('presence')
  @RateLimit(READ)
  async online(@Req() req: Request): Promise<{ online: string[] }> {
    return { online: await this.availability.online(callerOf(req).tenantId) };
  }

  @Get('conversations')
  @RateLimit(READ)
  inbox(@Req() req: Request, @Query(new ZodValidationPipe(inboxQuerySchema)) query: InboxQuery) {
    return this.agents.inbox(callerOf(req), query);
  }

  @Get('conversations/:id/messages')
  @RateLimit(READ)
  messages(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(messagesQuerySchema)) query: MessagesQuery,
  ): Promise<AgentMessagePage> {
    return refusing(() => this.agents.messages(callerOf(req), id, query));
  }

  /** A reply, or with `internal: true` a note only agents see. */
  @Post('conversations/:id/messages')
  @RateLimit(SEND)
  reply(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(replySchema)) body: ReplyBody,
  ): Promise<AgentMessageView> {
    return refusing(() => this.agents.reply(callerOf(req), id, body));
  }

  @Post('conversations/:id/assign')
  @HttpCode(200)
  @RateLimit(SEND)
  assign(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(assignSchema)) body: AssignBody,
  ): Promise<AgentConversationView> {
    return refusing(() => this.agents.assign(callerOf(req), id, body));
  }

  @Post('conversations/:id/resolve')
  @HttpCode(200)
  @RateLimit(SEND)
  resolve(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<AgentConversationView> {
    return refusing(() => this.agents.resolve(callerOf(req), id));
  }

  @Post('conversations/:id/close')
  @HttpCode(200)
  @RateLimit(SEND)
  close(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<AgentConversationView> {
    return refusing(() => this.agents.close(callerOf(req), id));
  }

  @Post('conversations/:id/typing')
  @HttpCode(200)
  @RateLimit(TYPING)
  typing(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<{ expiresInMs: number }> {
    return refusing(() => this.agents.typing(callerOf(req), id));
  }

  @Post('conversations/:id/read')
  @RateLimit(READ)
  read(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(readSchema)) body: ReadBody,
  ): Promise<{ lastReadSeq: number }> {
    return refusing(() => this.agents.markRead(callerOf(req), id, body ?? {}));
  }
}
