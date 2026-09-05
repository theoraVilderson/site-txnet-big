import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UsePipes,
} from '@nestjs/common';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ok } from '../../common/response/response.util';
import { RateLimit } from '../decorators/rate-limit.decorator';
import {
  BOT_PLATFORMS,
  BotClientRegistry,
  BotPlatform,
} from '../otp/senders/bot-client.registry';
import { BotLinkService } from './bot-link.service';
import { botLinkStatusSchema } from './bot-link.schema';
import { BotUpdate } from './bot-link.types';

/**
 * The bot side of account linking.
 *
 * The webhook is public by necessity — Telegram and Bale call it from their
 * own infrastructure — so the shared secret sits in the path, and Telegram's
 * `X-Telegram-Bot-Api-Secret-Token` header is checked as well when it sends
 * one. An unauthenticated or unknown call is a 404: a webhook URL that
 * answers differently for a wrong secret is a webhook URL that can be probed.
 */
@Controller('auth/bots')
export class BotLinkController {
  constructor(
    private readonly links: BotLinkService,
    private readonly bots: BotClientRegistry,
  ) {}

  @Post(':platform/webhook/:secret')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) =>
      `bot:webhook:${req.params?.platform}:${
        req.body?.message?.chat?.id ?? req.ip
      }`,
    limit: 30,
    windowSec: 60,
  })
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
    const header = req.get('x-telegram-bot-api-secret-token');
    if (header && !secretMatches(header, expected)) {
      throw new NotFoundException();
    }

    // Always 200: a non-2xx makes the platform redeliver the same update, and
    // handling is best-effort by design.
    await this.links.handleUpdate(platform, update);
    return { ok: true };
  }

  /**
   * "Has the user finished in the messenger yet?" — polled by the screen that
   * is showing the deep link.
   */
  @Post('link/status')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(botLinkStatusSchema))
  // Generous on purpose: the screen polls every 2.5s for as long as the user
  // is in the messenger, and each call is one Redis read.
  @RateLimit({
    key: (req) => `bot:link:status:${req.ip}`,
    limit: 300,
    windowSec: 900,
  })
  async status(@Body() body: { linkToken: string }) {
    return ok(await this.links.status(body.linkToken), 'auth.botLinkStatus');
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
