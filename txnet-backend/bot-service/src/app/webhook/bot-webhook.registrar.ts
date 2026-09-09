import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotCopy } from '../locale/bot-copy';
import {
  BotClientRegistry,
  BotIntegration,
  redactedWebhookUrl,
  resolveWebhookBase,
  TelegramLikeBotClient,
  webhookUrl,
} from '@txnet-backend/messenger';
import { AuthApiBotIntegrationDirectory } from './bot-integration.directory';

/**
 * Points every tenant's bot at this service's own webhook path on boot, and
 * says whether it worked (F-321).
 *
 * **The platform registers on the tenant's behalf.** A reseller pastes a token
 * into the panel and is done: it is this process, holding that token for the
 * length of one call, that tells Telegram or Bale where to deliver. The
 * alternative — asking fifty resellers to call `setWebhook` themselves — is
 * fifty chances to point a bot somewhere else.
 *
 * It moved off environment variables with F-066-i. Before that there was one
 * bot per platform and its URL carried a shared secret; now there is one per
 * `BotIntegration`, its URL carries that row's own `webhookPath`, and the
 * secret token travels in the header the platform echoes back.
 *
 * The outcome of each registration is written back to the row — `status` and
 * `lastErrorAt` — because "the bot stopped answering" has to be answerable
 * from the panel rather than from this service's log.
 *
 * It moved here from `auth-service` with ADR-0011: a bot token holds exactly
 * one webhook URL, so whoever registers it owns every update.
 */
@Injectable()
export class BotWebhookRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(BotWebhookRegistrar.name);

  constructor(
    private readonly config: ConfigService,
    private readonly bots: BotClientRegistry,
    private readonly directory: AuthApiBotIntegrationDirectory,
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

    const integrations = await this.directory.registrable();
    if (!integrations.length) {
      this.logger.log('no bot integrations to register');
      return;
    }

    // Registration is best-effort and must never hold up (or fail) boot: a
    // messenger that cannot be reached right now is a channel that is down,
    // not a service that is broken. One tenant's failure is one tenant's,
    // which is what per-integration handling buys over the old per-platform
    // loop.
    for (const integration of integrations) {
      await this.register(integration);
      await this.publishCommands(integration);
    }
  }

  /**
   * Publishes the command menu in every language this deployment serves.
   * Best-effort and never fatal, for the same reason webhook registration is:
   * a stale command menu is a channel that is slightly less discoverable, not
   * a service that is broken.
   */
  private async publishCommands(integration: BotIntegration): Promise<void> {
    const client = await this.client(integration, 'publishCommands');
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
      `${this.name(integration)}: command menu published (${languages.join(', ')})`,
    );
  }

  /**
   * Where this service is reachable, per platform — `messenger` owns the
   * precedence and the URL shape, because the rotation route (F-322) builds
   * the same address from another process and the two must not drift.
   */
  private publicBase(integration: BotIntegration): string | null {
    return resolveWebhookBase(
      (key) => this.config.get<string>(key),
      integration.platform,
    );
  }

  private async register(integration: BotIntegration): Promise<void> {
    const base = this.publicBase(integration);
    if (!base) {
      this.logger.warn(
        `${integration.platform}: no webhook base — set ` +
          `${integration.platform.toUpperCase()}_WEBHOOK_PUBLIC_BASE, ` +
          `BOT_WEBHOOK_PUBLIC_BASE or DOMAIN_NAME`,
      );
      return;
    }

    const client = await this.client(integration, 'register');
    if (!client) {
      await this.directory.recordRegistration(integration, false);
      return;
    }

    const url = webhookUrl(base, integration);
    const current = await client.getWebhookInfo();

    if (current === null) {
      this.logger.warn(
        `${this.name(integration)}: could not read the current webhook — not overwriting it`,
      );
      await this.directory.recordRegistration(integration, false);
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
      this.logger.log(`${this.name(integration)}: webhook already registered`);
      await this.directory.recordRegistration(integration, true);
      return;
    }

    // The URL carries the path, which is the credential — never logged in full.
    this.logger.log(
      `${this.name(integration)}: registering webhook ` +
        redactedWebhookUrl(base, integration.platform) +
        (current.url && current.url !== url
          ? ' (replacing a different one)'
          : '') +
        (!delivers
          ? ` (previous registration delivered only: ${current.allowedUpdates.join(', ')})`
          : ''),
    );

    const secret = await this.secret(integration);
    const ok = await client.setWebhook(url, secret);
    if (ok) this.logger.log(`${this.name(integration)}: webhook registered`);
    await this.directory.recordRegistration(integration, ok);
  }

  private client(integration: BotIntegration, step: string) {
    return this.bots.client(integration, `bot-app:BotWebhookRegistrar.${step}`);
  }

  /**
   * The secret token to register with, and the header this bot's updates must
   * then carry (F-321).
   *
   * It is a vault credential like the token is, so it is fetched the same way
   * and held for exactly one call. `undefined` registers without one, which is
   * what a tenant who has not been given a secret gets — the path is still 32
   * random bytes.
   */
  private async secret(
    integration: BotIntegration,
  ): Promise<string | undefined> {
    const value = await this.directory.webhookSecret(integration);
    return value ?? undefined;
  }

  /** `telegram/@acmebot` — enough to find the row, never the path. */
  private name(integration: BotIntegration): string {
    return `${integration.platform}/@${integration.botUsername}`;
  }
}
