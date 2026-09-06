import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotCopy } from '../locale/bot-copy';
import {
  BOT_PLATFORMS,
  BotClientRegistry,
  BotPlatform,
  TelegramLikeBotClient,
} from '@txnet-backend/messenger';

/**
 * Points every configured bot at this service's own webhook route on boot.
 *
 * It moved here from `auth-service` with ADR-0011: a bot token holds exactly
 * one webhook URL, so whoever registers it owns every update, and that is now
 * `bot-service`. The old `auth-service` route still answers for one release,
 * but nothing points a bot at it any more.
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
    private readonly copy: BotCopy,
  ) {}

  /**
   * The commands worth putting in the messenger's own command menu.
   *
   * A chat has no menu bar: a command the user has to already know about is a
   * command that does not exist. Each one is also reachable as a button, so
   * this list is discovery, never the only way in.
   */
  private static readonly COMMANDS = [
    { command: 'start', key: 'bot.command.start' },
    { command: 'menu', key: 'bot.command.menu' },
    { command: 'help', key: 'bot.command.help' },
    { command: 'lang', key: 'bot.command.lang' },
    { command: 'cancel', key: 'bot.command.cancel' },
    { command: 'logout', key: 'bot.command.logout' },
  ];

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<string>('BOT_WEBHOOK_AUTO_REGISTER') === 'false') {
      this.logger.log('BOT_WEBHOOK_AUTO_REGISTER=false — leaving webhooks alone');
      return;
    }

    // Registration is best-effort and must never hold up (or fail) boot: a
    // messenger that cannot be reached right now is a channel that is down,
    // not a service that is broken.
    await Promise.all(BOT_PLATFORMS.map((p) => this.register(p)));
    await Promise.all(BOT_PLATFORMS.map((p) => this.publishCommands(p)));
  }

  /**
   * Publishes the command menu in every language this deployment serves.
   * Best-effort and never fatal, for the same reason webhook registration is:
   * a stale command menu is a channel that is slightly less discoverable, not
   * a service that is broken.
   */
  private async publishCommands(platform: BotPlatform): Promise<void> {
    const client = this.bots.client(platform);
    if (!client) return;

    const languages = (
      this.config.get<string>('BOT_COMMAND_LANGS') ?? 'fa,en'
    )
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);
    const fallback = this.config.get<string>('DEFAULT_LANGUAGE', 'fa');

    const listFor = (lang: string) =>
      BotWebhookRegistrar.COMMANDS.map(({ command, key }) => ({
        command,
        description: this.copy.text(lang, { key }),
      }));

    // The unlabelled list is what a client with an unknown locale is shown.
    await client.setMyCommands(listFor(fallback));
    for (const lang of languages) {
      await client.setMyCommands(listFor(lang), lang);
    }
    this.logger.log(
      `${platform}: command menu published (${languages.join(', ')})`,
    );
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

  /** The exact path `WebhookController` serves, under the global `/api` prefix. */
  private webhookUrl(base: string, platform: BotPlatform, secret: string): string {
    return `${base}/api/bot/${platform}/webhook/${secret}`;
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
    const current = await client.getWebhookInfo();

    if (current === null) {
      this.logger.warn(
        `${platform}: could not read the current webhook — not overwriting it`,
      );
      return;
    }

    // The URL is only half of a registration. A webhook pointing at the right
    // place but registered for the wrong update types delivers messages and
    // drops every button tap, and it never heals on its own — the URL matches,
    // so a URL-only check calls it done on every boot forever. Both halves are
    // compared, so an old narrow registration is rewritten once and then left
    // alone.
    const delivers = TelegramLikeBotClient.deliversEveryUpdate(
      current.allowedUpdates,
    );
    if (current.url === url && delivers) {
      this.logger.log(`${platform}: webhook already registered`);
      return;
    }

    // The URL carries the secret, so it is never logged in full.
    this.logger.log(
      `${platform}: registering webhook ${base}/api/bot/${platform}/webhook/***` +
        (current.url && current.url !== url
          ? ' (replacing a different one)'
          : '') +
        (!delivers
          ? ` (previous registration delivered only: ${current.allowedUpdates.join(', ')})`
          : ''),
    );
    if (await client.setWebhook(url, secret)) {
      this.logger.log(`${platform}: webhook registered`);
    }
  }
}
