import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { BackendI18nKeys, RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request, Response } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import type { Availability } from '../availability/availability';
import { SupportAttachmentService } from './attachments.service';
import {
  AttachBody,
  ListQuery,
  MessagesQuery,
  OpenBody,
  ReadBody,
  SendBody,
  attachSchema,
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

const TYPING = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SUPPORT_TYPING, identityOf(req).userId),
  configKey: 'SUPPORT_TYPING_RATE_LIMIT' as const,
  windowSec: 60,
};

const E = BackendI18nKeys.errors.support;

const REFUSAL: Record<ConversationRejection, { status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 503; i18nKey: string }> = {
  not_found: { status: 404, i18nKey: E.conversationNotFound },
  closed: { status: 409, i18nKey: E.conversationClosed },
  category_unknown: { status: 404, i18nKey: E.categoryUnknown },
  category_key_taken: { status: 409, i18nKey: E.categoryKeyTaken },
  category_invalid: { status: 400, i18nKey: E.categoryInvalid },
  category_in_use: { status: 409, i18nKey: E.categoryInUse },
  too_many_unfinished: { status: 409, i18nKey: E.tooManyUnfinished },
  empty_message: { status: 400, i18nKey: E.emptyMessage },
  too_many_files: { status: 400, i18nKey: E.tooManyFiles },
  file_too_large: { status: 413, i18nKey: E.fileTooLarge },
  file_rejected: { status: 415, i18nKey: E.fileRejected },
  file_infected: { status: 422, i18nKey: E.fileInfected },
  scan_unavailable: { status: 503, i18nKey: E.scanUnavailable },
  quota_exceeded: { status: 409, i18nKey: E.quotaExceeded },
  assignee_unknown: { status: 404, i18nKey: E.assigneeUnknown },
  hours_invalid: { status: 400, i18nKey: E.hoursInvalid },
  sla_invalid: { status: 400, i18nKey: E.slaInvalid },
  canned_unknown: { status: 404, i18nKey: E.cannedUnknown },
  canned_key_taken: { status: 409, i18nKey: E.cannedKeyTaken },
  canned_invalid: { status: 400, i18nKey: E.cannedInvalid },
  not_finished: { status: 409, i18nKey: E.notFinished },
  already_rated: { status: 409, i18nKey: E.alreadyRated },
  not_closed: { status: 409, i18nKey: E.notClosed },
  reopen_expired: { status: 409, i18nKey: E.reopenExpired },
  lifecycle_invalid: { status: 400, i18nKey: E.lifecycleInvalid },
  not_platform_staff: { status: 403, i18nKey: E.notPlatformStaff },
  reseller_not_found: { status: 404, i18nKey: E.resellerNotFound },
  consent_required: { status: 403, i18nKey: E.consentRequired },
  consent_read_only: { status: 403, i18nKey: E.consentReadOnly },
};

/** A multipart file as multer holds it in memory. */
interface UploadedPart {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

/**
 * The user's support (F-033-b, ADR-0112). Any signed-in user of the tenant;
 * no permission — a user's own conversations are theirs by `userId`, which the
 * service holds on every call (invariant 6).
 */
@Controller('support')
export class SupportConversationsController {
  constructor(
    private readonly support: SupportConversationService,
    private readonly attachments: SupportAttachmentService,
  ) {}

  @Get('categories')
  @RateLimit(READ)
  categories(@Req() req: Request): Promise<CategoryView[]> {
    return this.support.categories(callerOf(req), languageOf(req));
  }

  /** Whether a human answers now, else when support opens (F-033-g) — the wait notice before and after opening. */
  @Get('availability')
  @RateLimit(READ)
  availability(@Req() req: Request): Promise<Availability> {
    return this.support.whenAnswered(callerOf(req));
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

  /**
   * A message with files (F-033-f): multipart, the files as `files` (repeat
   * the field), an optional text as `body`. Counts against the send limit.
   */
  @Post('conversations/:id/attachments')
  @RateLimit(SEND)
  @UseInterceptors(FilesInterceptor('files'))
  attach(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @UploadedFiles() files: UploadedPart[] | undefined,
    @Body(new ZodValidationPipe(attachSchema)) body: AttachBody,
  ): Promise<MessageView> {
    const incoming = (files ?? []).map((f) => ({
      // Multer reads the part's name as latin1; the browser sent UTF-8.
      originalName: Buffer.from(f.originalname, 'latin1').toString('utf8'),
      contentType: f.mimetype,
      bytes: f.buffer,
    }));
    return refusing(() => this.attachments.send(callerOf(req), id, { body: body?.body, files: incoming }));
  }

  /**
   * One file's bytes, to the conversation's own user (F-309): for a surface
   * with no panel Host to spend the signed `url` on — the bot. Outside the
   * envelope, the body is the file; a refusal is the ordinary envelope.
   */
  @Get('conversations/:id/attachments/:attachmentId')
  @RateLimit(READ)
  async download(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string,
  ): Promise<void> {
    const file = await refusing(() => this.attachments.download(callerOf(req), id, attachmentId));
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.status(200).send(file.bytes);
  }

  /** "I am typing" (F-034): published to the thread's readers, stored nowhere. Repeat every few seconds while typing. */
  @Post('conversations/:id/typing')
  @HttpCode(200)
  @RateLimit(TYPING)
  typing(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<{ expiresInMs: number }> {
    return refusing(() => this.support.typing(callerOf(req), id));
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

export function callerOf(req: Request): SupportCaller {
  const identity = identityOf(req);
  return { tenantId: identity.tenantId, userId: identity.userId };
}

/** What `LanguageMiddleware` resolved from `Accept-Language`. */
export function languageOf(req: Request): string {
  return (req as Request & { language?: string }).language ?? 'fa';
}

export async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (!(e instanceof ConversationRefused)) throw e;
    const { status, i18nKey } = REFUSAL[e.reason];
    throw new HttpException({ i18nKey, reason: e.reason }, status);
  }
}
