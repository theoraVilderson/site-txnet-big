import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { RateLimitBucket, accessTraceOf, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { MessagesQuery, ReadBody, messagesQuerySchema, readSchema } from '../conversations/conversations.schema';
import { refusing } from '../conversations/conversations.controller';
import type { SupportCaller } from '../conversations/refusal';
import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { AssignBody, InboxQuery, PriorityBody, ReplyBody, assignSchema, inboxQuerySchema, prioritySchema, replySchema } from './agent.schema';
import { AgentConversationView, AgentMessagePage, AgentMessageView, SupportAgentService } from './agent.service';
import { ConsentNeed, PlatformSupportDoor } from './platform-door';
import { SupportAgentGuard } from './support-agent.guard';
import { SupportUserContext, UserContext } from './user-context';

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

/**
 * A reseller's inbox, for the platform's staff (F-033-l, catalog §11.6):
 * `/api/support/tenants/:tenantId/agent/*` — the agent routes of
 * `SupportAgentController`, each behind {@link PlatformSupportDoor}: a live
 * consent of that reseller, `act` for every write. No presence and no typing:
 * platform staff are not the reseller's agents and never make it look staffed.
 */
@Controller('support/tenants/:tenantId/agent')
@UseGuards(SupportAgentGuard)
export class PlatformAgentController {
  constructor(
    private readonly agents: SupportAgentService,
    private readonly door: PlatformSupportDoor,
    private readonly userContext: SupportUserContext,
  ) {}

  @Get('conversations')
  @RateLimit(READ)
  inbox(
    @Req() req: Request,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query(new ZodValidationPipe(inboxQuerySchema)) query: InboxQuery,
  ) {
    return this.enter(req, tenantId, 'read', (agent) => this.agents.inbox(agent, query));
  }

  @Get('conversations/:id/messages')
  @RateLimit(READ)
  messages(
    @Req() req: Request,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(messagesQuerySchema)) query: MessagesQuery,
  ): Promise<AgentMessagePage> {
    return this.enter(req, tenantId, 'read', (agent) => this.agents.messages(agent, id, query));
  }

  /** The sidebar (F-033-m) — it names a person, so `read` consent at least. */
  @Get('conversations/:id/context')
  @RateLimit(READ)
  context(
    @Req() req: Request,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<UserContext> {
    return this.enter(req, tenantId, 'read', (agent) => this.userContext.forConversation(agent, id));
  }

  @Post('conversations/:id/messages')
  @RateLimit(SEND)
  reply(
    @Req() req: Request,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(replySchema)) body: ReplyBody,
  ): Promise<AgentMessageView> {
    return this.enter(req, tenantId, 'act', (agent) => this.agents.reply(agent, id, body));
  }

  @Post('conversations/:id/assign')
  @HttpCode(200)
  @RateLimit(SEND)
  assign(
    @Req() req: Request,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(assignSchema)) body: AssignBody,
  ): Promise<AgentConversationView> {
    return this.enter(req, tenantId, 'act', (agent) => this.agents.assign(agent, id, body));
  }

  @Post('conversations/:id/priority')
  @HttpCode(200)
  @RateLimit(SEND)
  prioritize(
    @Req() req: Request,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(prioritySchema)) body: PriorityBody,
  ): Promise<AgentConversationView> {
    return this.enter(req, tenantId, 'act', (agent) => this.agents.prioritize(agent, id, body));
  }

  @Post('conversations/:id/resolve')
  @HttpCode(200)
  @RateLimit(SEND)
  resolve(
    @Req() req: Request,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AgentConversationView> {
    return this.enter(req, tenantId, 'act', (agent) => this.agents.resolve(agent, id));
  }

  @Post('conversations/:id/close')
  @HttpCode(200)
  @RateLimit(SEND)
  close(
    @Req() req: Request,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AgentConversationView> {
    return this.enter(req, tenantId, 'act', (agent) => this.agents.close(agent, id));
  }

  /** A read cursor is the reader's own, not an act on the reseller: `read` suffices. */
  @Post('conversations/:id/read')
  @RateLimit(READ)
  read(
    @Req() req: Request,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(readSchema)) body: ReadBody,
  ): Promise<{ lastReadSeq: number }> {
    return this.enter(req, tenantId, 'read', (agent) => this.agents.markRead(agent, id, body ?? {}));
  }

  private enter<T>(req: Request, tenantId: string, need: ConsentNeed, work: (agent: SupportCaller) => Promise<T>): Promise<T> {
    const { userId, tenantId: home, permissions } = identityOf(req);
    return refusing(() => this.door.run({ userId, tenantId: home, permissions, trace: accessTraceOf(req) }, tenantId, need, work));
  }
}
