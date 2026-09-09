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
import {
  BotClientRegistry,
  BotPlatform,
  BotUpdate,
  isBotPlatform,
} from '@txnet-backend/messenger';
import { BotDispatcher } from '../conversation/bot.dispatcher';
import { UpdateNormalizer } from './update.normalizer';

/**
 * The bot's front door: one unguessable path per bot (ADR-0009, F-320).
 *
 * `POST /bots/{platform}/{webhookPath}`, where `webhookPath` is the random
 * 32-byte string on that tenant's own `BotIntegration` row. **The tenant is
 * resolved from the path, never from the message body** — a body is written by
 * whoever sent the update, and a tenancy decision taken from it is a tenancy
 * decision taken by a stranger. Resolving the path is what opens the scope
 * everything downstream runs in, which is what finally lets a bot request name
 * the tenant it belongs to (F-065-a, ADR-0023).
 *
 * Three rules this route exists to hold:
 *   - an unknown path, an unknown platform, a wrong secret token and an
 *     integration whose token is gone all answer **404**, identical to a route
 *     that does not exist. A URL that answers differently for a wrong secret is
 *     a URL that can be probed.
 *   - the `X-Telegram-Bot-Api-Secret-Token` header is verified on **every**
 *     request, not only when the platform chose to send one (F-321). Bale does
 *     not send the field, and that is the one case a missing header is allowed
 *     — see {@link secretRequired}.
 *   - once the path *and* the secret are known good the answer is **always
 *     200**, whatever the handling did. A non-2xx makes the platform redeliver
 *     the same update, and handling is best-effort by design.
 */
@Controller('bots')
export class WebhookController {
  constructor(
    private readonly bots: BotClientRegistry,
    private readonly normalizer: UpdateNormalizer,
    private readonly dispatcher: BotDispatcher,
  ) {}

  @Post(':platform/:webhookPath')
  @HttpCode(HttpStatus.OK)
  async webhook(
    @Param('platform') platformParam: string,
    @Param('webhookPath') webhookPath: string,
    @Body() update: BotUpdate,
    @Req() req: Request,
  ) {
    if (!isBotPlatform(platformParam)) throw new NotFoundException();
    const platform: BotPlatform = platformParam;

    const integration = await this.bots.byWebhookPath(platform, webhookPath);
    if (!integration) throw new NotFoundException();

    const header = req.get('x-telegram-bot-api-secret-token');
    if (secretRequired(platform) || header !== undefined) {
      const valid = await this.bots.verifyWebhookSecret(
        integration,
        header ?? '',
      );
      if (!valid) throw new NotFoundException();
    }

    const ctx = this.normalizer.normalize(platform, integration, update);
    if (ctx) await this.dispatcher.handle(ctx);

    return { ok: true };
  }
}

/**
 * Whether this platform is expected to send the secret-token header.
 *
 * Telegram echoes back whatever `setWebhook` registered, so its absence is a
 * forged request. Bale accepts the field on `setWebhook` and does not send it,
 * so requiring it there would reject every real Bale update — the path is the
 * whole credential on that platform, which is exactly why it is 32 random
 * bytes. A header that *is* present is verified on both, so a wrong one is
 * never waved through.
 */
function secretRequired(platform: BotPlatform): boolean {
  return platform === 'telegram';
}
