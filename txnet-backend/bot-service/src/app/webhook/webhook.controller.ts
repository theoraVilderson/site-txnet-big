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
import { BotUpdatePublisher } from './bot-update.publisher';
import { UpdateNormalizer } from './update.normalizer';

/**
 * The bot's front door: one unguessable path per bot (ADR-0009, F-320).
 *
 * **It verifies and enqueues; it does not converse (F-067-b).** Until
 * 2026-09-10 this route ran the whole conversation — the dispatcher, the
 * `auth-api` call inside it and the `sendMessage` back to the platform —
 * before answering. Telegram gives a webhook a few seconds and redelivers what
 * it did not hear back about, so one slow tenant occupied the shared
 * `bot-service` and earned duplicate updates for everyone on it. The flow now
 * runs in `worker-service`, which calls back into this process's
 * `internal/bots/dispatch`; per-chat ordering is a property of the queue set
 * (D-16, `shared-core` `bot-update.ts`).
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
 *   - once the path *and* the secret are known good the answer is **200 as
 *     soon as the update is safely on the broker** — and only then. A non-2xx
 *     makes the platform redeliver, which used to be the thing to avoid at any
 *     cost, because handling was best-effort and a redelivery replayed whatever
 *     the flow had already done. Now it is the recovery path: an update the
 *     broker did not confirm would otherwise be lost with a 200 behind it, so
 *     it escapes as a 5xx and the platform brings it back (D-18).
 */
@Controller('bots')
export class WebhookController {
  constructor(
    private readonly bots: BotClientRegistry,
    private readonly normalizer: UpdateNormalizer,
    private readonly updates: BotUpdatePublisher,
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

    // Normalised *here*, while the integration that resolved the path is in
    // hand: the last place that knows what a Telegram `Update` looks like stays
    // in front of the queue, so what rides the broker is this platform's own
    // shape rather than a vendor's. What does not ride it is the integration —
    // `BotUpdateMessage` carries the webhook path instead, and the consumer's
    // side resolves the tenant from it exactly as this route just did.
    const ctx = this.normalizer.normalize(platform, integration, update);
    if (ctx) {
      const { integration: _resolved, ...message } = ctx;
      await this.updates.publish({ ...message, webhookPath });
    }

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
