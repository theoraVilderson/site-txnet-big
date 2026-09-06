import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';
import {
  BOT_PLATFORMS,
  BotClientRegistry,
  BotPlatform,
  BotUpdate,
} from '@txnet-backend/messenger';
import { BotDispatcher } from '../conversation/bot.dispatcher';
import { UpdateNormalizer } from './update.normalizer';

/**
 * The bot's front door: one unguessable path per bot (ADR-0009).
 *
 * Two rules this route exists to hold:
 *   - a wrong secret, an unknown platform or an unconfigured bot answers
 *     **404**, identical to a route that does not exist. A URL that answers
 *     differently for a wrong secret is a URL that can be probed.
 *   - once the path is known the answer is **always 200**, whatever the
 *     handling did. A non-2xx makes the platform redeliver the same update,
 *     and handling is best-effort by design.
 */
@Controller('bot')
export class WebhookController {
  constructor(
    private readonly bots: BotClientRegistry,
    private readonly normalizer: UpdateNormalizer,
    private readonly dispatcher: BotDispatcher,
  ) {}

  @Post(':platform/webhook/:secret')
  @HttpCode(HttpStatus.OK)
  async webhook(
    @Param('platform') platformParam: string,
    @Param('secret') secret: string,
    @Body() update: BotUpdate,
    @Req() req: Request,
  ) {
    const platform = this.resolvePlatform(platformParam);
    const expected = this.bots.webhookSecret(platform);
    if (!expected || !secretMatches(secret, expected)) {
      throw new NotFoundException();
    }
    // Telegram sends its own header when a secret was registered with the
    // webhook; Bale ignores the field and is guarded by the path alone.
    const header = req.get('x-telegram-bot-api-secret-token');
    if (header && !secretMatches(header, expected)) {
      throw new NotFoundException();
    }

    const ctx = this.normalizer.normalize(platform, update);
    if (ctx) await this.dispatcher.handle(ctx);

    return { ok: true };
  }

  private resolvePlatform(value: string): BotPlatform {
    const platform = BOT_PLATFORMS.find((p) => p === value);
    if (!platform) throw new NotFoundException();
    return platform;
  }
}

/** Constant-time compare that tolerates a length mismatch. */
function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
