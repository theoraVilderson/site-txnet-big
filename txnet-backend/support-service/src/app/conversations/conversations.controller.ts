import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { BackendI18nKeys, RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import {
  ListQuery,
  MessagesQuery,
  OpenBody,
  ReadBody,
  SendBody,
  listQuerySchema,
  messagesQuerySchema,
  openSchema,
  readSchema,
  sendSchema,
} from './conversations.schema';
import {
  CategoryView,
  ConversationRefused,
  ConversationRejection,
  ConversationSummary,
  MessagePage,
  MessageView,
  SupportCaller,
  SupportConversationService,
} from './conversations.service';

const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SUPPORT_READ, identityOf(req).userId),
  configKey: 'SUPPORT_READ_RATE_LIMIT' as const,
  windowSec: 60,
};

const OPEN = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SUPPORT_OPEN, identityOf(req).userId),
  configKey: 'SUPPORT_OPEN_RATE_LIMIT' as const,
  windowSec: 3600,
};

const SEND = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SUPPORT_SEND, identityOf(req).userId),
  configKey: 'SUPPORT_SEND_RATE_LIMIT' as const,
  windowSec: 60,
};

const E = BackendI18nKeys.errors.support;

const REFUSAL: Record<ConversationRejection, { status: 404 | 409; i18nKey: string }> = {
  not_found: { status: 404, i18nKey: E.conversationNotFound },
  closed: { status: 409, i18nKey: E.conversationClosed },
  category_unknown: { status: 404, i18nKey: E.categoryUnknown },
  too_many_unfinished: { status: 409, i18nKey: E.tooManyUnfinished },
};

/**
 * The user's support (F-033-b, ADR-0112). Any signed-in user of the tenant;
 * no permission — a user's own conversations are theirs by `userId`, which the
 * service holds on every call (invariant 6).
 */
@Controller('support')
export class SupportConversationsController {
  constructor(private readonly support: SupportConversationService) {}

  @Get('categories')
  @RateLimit(READ)
  categories(@Req() req: Request): Promise<CategoryView[]> {
    return this.support.categories(callerOf(req), languageOf(req));
  }

  @Get('conversations')
  @RateLimit(READ)
  list(@Req() req: Request, @Query(new ZodValidationPipe(listQuerySchema)) query: ListQuery) {
    return this.support.list(callerOf(req), query);
  }

  @Post('conversations')
  @RateLimit(OPEN)
  open(@Req() req: Request, @Body(new ZodValidationPipe(openSchema)) body: OpenBody): Promise<ConversationSummary> {
    return refusing(() => this.support.open(callerOf(req), body));
  }

  @Get('conversations/:id/messages')
  @RateLimit(READ)
  messages(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(messagesQuerySchema)) query: MessagesQuery,
  ): Promise<MessagePage> {
    return refusing(() => this.support.messages(callerOf(req), id, query));
  }

  @Post('conversations/:id/messages')
  @RateLimit(SEND)
  send(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(sendSchema)) body: SendBody,
  ): Promise<MessageView> {
    return refusing(() => this.support.send(callerOf(req), id, body));
  }

  @Post('conversations/:id/read')
  @RateLimit(READ)
  read(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(readSchema)) body: ReadBody,
  ): Promise<{ lastReadSeq: number }> {
    return refusing(() => this.support.markRead(callerOf(req), id, body ?? {}));
  }
}

function callerOf(req: Request): SupportCaller {
  const identity = identityOf(req);
  return { tenantId: identity.tenantId, userId: identity.userId };
}

/** What `LanguageMiddleware` resolved from `Accept-Language`. */
function languageOf(req: Request): string {
  return (req as Request & { language?: string }).language ?? 'fa';
}

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof ConversationRefused)) throw e;
    const { status, i18nKey } = REFUSAL[e.reason];
    throw new HttpException({ i18nKey, reason: e.reason }, status);
  }
}
