import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BOT_PLATFORMS,
  BotClientRegistry,
  BotPlatform,
} from '../otp/senders/bot-client.registry';

/**
 * Points every configured bot at this service's own webhook route on boot.
 *
 * A bot token holds exactly one webhook URL, and nothing in the product ever
 * sets it — so before this existed the deep link opened a bot that answered
 * nothing: `/start <token>` reached the platform and stopped there, while the
 * panel polled a link that could never leave `pending`.
 *
 * The URL is derived, never configured twice: it is the route
 * `BotLinkController` serves, built from the public base and the platform's
 * own webhook secret. `scripts/set-bot-webhook.sh` builds the identical URL
 * for the by-hand case.
 */
@Injectable()
export class BotWebhookRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(BotWebhookRegistrar.name);

  constructor(
    private readonly config: ConfigService,
    private readonly bots: BotClientRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('BOT_WEBHOOK_AUTO_REGISTER') === 'false') {
      this.logger.log('BOT_WEBHOOK_AUTO_REGISTER=false — leaving webhooks alone');
      return;
    }

    // Registration is best-effort and must never hold up (or fail) boot: a
    // messenger that cannot be reached right now is a channel that is down,
    // not a service that is broken.
    await Promise.all(BOT_PLATFORMS.map((p) => this.register(p)));
  }

  /**
   * Where *this* platform reaches this service, most specific first:
   *
   * 1. `<PLATFORM>_WEBHOOK_PUBLIC_BASE` — one platform needs a different way
   *    in than the others. Telegram, for instance, cannot open a connection
   *    to every host on the internet, so its updates come back through a
   *    proxy while Bale calls the API directly.
   * 2. `BOT_WEBHOOK_PUBLIC_BASE` — every platform goes through the same
   *    front door: a dev tunnel, or another app fronting this API.
   * 3. `https://api.<DOMAIN_NAME>` — the convention the Traefik router and
   *    `scripts/set-bot-webhook.sh` already assume.
   */
  private publicBase(platform: BotPlatform): string | null {
    const perPlatform = this.config.get<string>(
      `${platform.toUpperCase()}_WEBHOOK_PUBLIC_BASE`,
    );
    const shared = this.config.get<string>('BOT_WEBHOOK_PUBLIC_BASE');
    const domain = this.config.get<string>('DOMAIN_NAME');
    const base =
      perPlatform || shared || (domain ? `https://api.${domain}` : null);
    return base ? base.replace(/\/+$/, '') : null;
  }

  /** The exact path `BotLinkController` serves, under the global `/api` prefix. */
  private webhookUrl(base: string, platform: BotPlatform, secret: string): string {
    return `${base}/api/auth/bots/${platform}/webhook/${secret}`;
  }

  private async register(platform: BotPlatform): Promise<void> {
    const client = this.bots.client(platform);
    const secret = this.bots.webhookSecret(platform);
    if (!client || !secret) {
      // Nothing to register: without both, the link flow is off anyway
      // (`BotClientRegistry.canLink`).
      return;
    }

    const base = this.publicBase(platform);
    if (!base) {
      this.logger.warn(
        `${platform}: no webhook base — set ${platform.toUpperCase()}_WEBHOOK_PUBLIC_BASE, BOT_WEBHOOK_PUBLIC_BASE or DOMAIN_NAME`,
      );
      return;
    }

    const url = this.webhookUrl(base, platform, secret);
    const current = await client.getWebhookUrl();

    if (current === null) {
      this.logger.warn(
        `${platform}: could not read the current webhook — not overwriting it`,
      );
      return;
    }
    if (current === url) {
      this.logger.log(`${platform}: webhook already registered`);
      return;
    }

    // The URL carries the secret, so it is never logged in full.
    this.logger.log(
      `${platform}: registering webhook ${base}/api/auth/bots/${platform}/webhook/***` +
        (current ? ' (replacing a different one)' : ''),
    );
    if (await client.setWebhook(url, secret)) {
      this.logger.log(`${platform}: webhook registered`);
    }
  }
}
