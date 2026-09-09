import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BotClientRegistry,
  BotIntegration,
  redactedWebhookUrl,
  resolveWebhookBase,
  webhookUrl,
} from '@txnet-backend/messenger';
import { PrismaBotIntegrationDirectory } from './bot-integration.directory';

/** What a rotation did, in the words a caller can render. */
export interface WebhookRotationResult {
  /** The row after the write. Its `webhookPath` is the new address. */
  integration: BotIntegration;
  /** Whether the platform accepted the new address. */
  registered: boolean;
}

/**
 * Rotates a bot's webhook path: the old one dies, then the new one is
 * registered upstream (F-322, catalog 10.2).
 *
 * **The order is the feature.** The row is written first and the platform is
 * told second, so the window between the two is a window in which the bot is
 * unreachable — never one in which a path that was rotated *because it leaked*
 * is still being answered. A rotation exists to end an address; an upstream API
 * that is slow, rate-limited or down is not a reason to keep answering it, and
 * "re-register, then retire" would make every rotation only as fast as
 * Telegram.
 *
 * The consequence is stated rather than hidden: a failed `setWebhook` leaves
 * the row `pending` with the new path, updates keep arriving at the dead old
 * address until the platform is told otherwise, and the caller is told
 * `registered: false`. `bot-service`'s `BotWebhookRegistrar` picks the row up
 * on its next boot, because `pending` is registrable — so the failure mode is a
 * bot that is quiet, not a bot that is quietly listening on a burned path.
 *
 * **Why this process registers at all.** ADR-0011 gave `bot-service` the
 * inbound webhook, and that is untouched: the URL registered here names
 * `bot-service`'s own door, built by `messenger`'s `webhookUrl` — the same
 * function that service's registrar uses, so the two cannot drift. What this
 * process has that the other does not is the row and the vault, and a rotation
 * is a write to both. Calling the Bot API from here is not new either; every
 * OTP this service sends to a chat is already such a call.
 */
@Injectable()
export class WebhookRotationService {
  private readonly logger = new Logger(WebhookRotationService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly directory: PrismaBotIntegrationDirectory,
    private readonly bots: BotClientRegistry,
  ) {}

  async rotate(
    integration: BotIntegration,
    actorId?: string,
  ): Promise<WebhookRotationResult> {
    // First, and before anything that can fail slowly: the old address stops
    // resolving the instant this returns.
    const rotated = await this.directory.rotateWebhookPath(integration);
    this.logger.log(
      `${this.name(rotated)}: webhook path rotated${
        actorId ? ` by ${actorId}` : ''
      } — the previous path no longer resolves`,
    );

    const registered = await this.register(rotated);
    await this.directory.recordRegistration(rotated.id, { ok: registered });
    return { integration: { ...rotated, status: registered ? 'active' : 'error' }, registered };
  }

  /**
   * Point the platform at the new address.
   *
   * Every failure is one `false`: the caller's next move is the same whether
   * the base was unset, the token was unusable or the API refused, and the
   * three are told apart in this log and nowhere else.
   */
  private async register(integration: BotIntegration): Promise<boolean> {
    const base = resolveWebhookBase(
      (key) => this.config.get<string>(key),
      integration.platform,
    );
    if (!base) {
      this.logger.warn(
        `${integration.platform}: no webhook base — set ` +
          `${integration.platform.toUpperCase()}_WEBHOOK_PUBLIC_BASE, ` +
          `BOT_WEBHOOK_PUBLIC_BASE or DOMAIN_NAME`,
      );
      return false;
    }

    const client = await this.bots.client(
      integration,
      'automation:WebhookRotationService',
    );
    if (!client) return false;

    // The secret is not rotated with the path. It is a second credential with
    // a rotation of its own (ADR-0026), and re-registering with the value the
    // in-flight updates are already signed with is what keeps an update sent a
    // moment before this call from being rejected by the header check.
    const secret = await this.directory.webhookSecret(
      integration,
      'automation:WebhookRotationService',
    );

    // The URL carries the path, which is the credential — never logged whole.
    this.logger.log(
      `${this.name(integration)}: registering ` +
        redactedWebhookUrl(base, integration.platform),
    );
    const ok = await client.setWebhook(
      webhookUrl(base, integration),
      secret ?? undefined,
    );
    if (!ok) {
      this.logger.error(
        `${this.name(integration)}: rotation registered no webhook — the bot ` +
          `is unreachable until it is re-registered`,
      );
    }
    return ok;
  }

  /** `telegram/@acmebot` — enough to find the row, never the path. */
  private name(integration: BotIntegration): string {
    return `${integration.platform}/@${integration.botUsername}`;
  }
}
