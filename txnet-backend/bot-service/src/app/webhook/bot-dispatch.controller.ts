import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  BotClientRegistry,
  BotContact,
  isBotPlatform,
} from '@txnet-backend/messenger';
import { ServiceOnlyGuard } from '../common/service-only.guard';
import { BotDispatcher } from '../conversation/bot.dispatcher';
import { ChatContext } from '../conversation/nav.types';

const dispatchSchema = z.object({
  platform: z.string().refine(isBotPlatform, 'unknown platform'),
  webhookPath: z.string().min(1),
  chatId: z.string().min(1),
  senderId: z.union([z.string(), z.number()]).optional(),
  lang: z.string().min(1),
  text: z.string().optional(),
  contact: z.unknown().optional(),
  callbackData: z.string().optional(),
  callbackQueryId: z.string().optional(),
  messageId: z.number().optional(),
});

/**
 * The seam a worker runs a bot conversation through (F-067-b).
 *
 * **Why the flow comes back into this process at all.** The conversation is
 * `bot-app`'s: `BotDispatcher`, five flows, the Redis nav store, the chat's
 * session and the `auth-api` client — about the whole service. Moving it into
 * `worker-service` means moving it across an Nx application boundary into a
 * workspace library, which is the question `VaultRetentionJob` (F-031-c) and
 * `OtpInternalController` (F-067-a) have both already answered the other way:
 * reach the owning service over the internal seam rather than move its code.
 *
 * What the feature removes is the flow — an `auth-api` round trip and a
 * `sendMessage` back to the platform — from the **webhook request**, which is
 * the request Telegram times out and redelivers. It was never about this
 * process's event loop.
 *
 * **The tenant is resolved here, from the path, exactly as the front door
 * resolves it.** The message carries `webhookPath` and no integration, so
 * nothing about tenancy travelled as data (F-320, ADR-0023). The consumer is
 * trusted to say *which bot* an update was addressed to; it is not trusted to
 * say whose bot that is, and this line is what keeps those two apart.
 */
@Controller('internal/bots')
@UseGuards(ServiceOnlyGuard)
export class BotDispatchController {
  private readonly logger = new Logger(BotDispatchController.name);

  constructor(
    private readonly bots: BotClientRegistry,
    private readonly dispatcher: BotDispatcher,
  ) {}

  /**
   * Run one queued update.
   *
   * A 200 with `dispatched:false` is an update whose bot no longer resolves —
   * an integration deleted or disabled between the webhook and the consumer.
   * That is an ack, not a failure: redelivering it would resolve to nothing
   * again for ever, and there is no user left to answer. Anything else throws,
   * which the consumer turns into a dead-letter row (F-067-d).
   */
  @Post('dispatch')
  @HttpCode(HttpStatus.OK)
  async dispatch(@Body() body: unknown): Promise<{ dispatched: boolean }> {
    const parsed = dispatchSchema.safeParse(body);
    if (!parsed.success) {
      // A body this service published itself and cannot now read is a bug in
      // the pair, not a bad caller — but it can only ever be redelivered as
      // the same unreadable body, so it is refused rather than retried.
      throw new BadRequestException('not a bot update');
    }
    const { platform, webhookPath } = parsed.data;
    if (!isBotPlatform(platform)) throw new BadRequestException('not a bot update');

    const integration = await this.bots.byWebhookPath(platform, webhookPath);
    if (!integration) {
      this.logger.warn(
        `dropping a queued ${platform} update: its webhook path no longer resolves`,
      );
      return { dispatched: false };
    }

    // Built field by field rather than spread from `parsed.data`, the same way
    // `UpdateNormalizer` builds one. The spread does not type-check here: this
    // workspace compiles without `strictNullChecks`, under which `undefined
    // extends T` holds for every `T`, so zod infers **every** key of a schema
    // as optional — including `chatId` and `lang`, which the schema requires
    // and `ChatContext` requires. Naming the fields keeps the two in step and
    // makes a field added to one and forgotten in the other a compile error.
    const ctx: ChatContext = {
      platform,
      integration,
      chatId: parsed.data.chatId,
      senderId: parsed.data.senderId,
      lang: parsed.data.lang,
      text: parsed.data.text,
      contact: parsed.data.contact as BotContact | undefined,
      callbackData: parsed.data.callbackData,
      callbackQueryId: parsed.data.callbackQueryId,
      messageId: parsed.data.messageId,
    };
    await this.dispatcher.handle(ctx);
    return { dispatched: true };
  }
}
