import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramLikeBotClient } from './telegram-like-bot.client';
import { BotPlatform } from './bot-platform';
import { buildDeepLink, DEEP_LINK_BASE } from './deep-link';
import { capabilitiesOf, MessengerCapabilities } from './capabilities';
import {
  BOT_INTEGRATION_DIRECTORY,
  BotIntegration,
  BotIntegrationDirectory,
} from './bot-integration';
import {
  verifyWebAppInitData,
  WebAppInitDataResult,
  WEB_APP_INIT_DATA_MAX_AGE_SEC,
} from './web-app-init-data';

/** The parts of a platform that are its shape, not a tenant's property. */
interface PlatformShape {
  apiBase: string;
  deepLinkBase: string;
}

/**
 * One bot client per `automation.BotIntegration`, selected by that
 * integration's own webhook path (F-320, catalog 10.2).
 *
 * It used to be one client per platform, built from `TELEGRAM_BOT_TOKEN` /
 * `BALE_BOT_TOKEN` at boot — which meant the platform owned every reseller's
 * bot and a request could not name the tenant it belonged to (F-065-a,
 * ADR-0023). What comes from the environment now is only what is true of a
 * *platform*: its API base and its deep-link shape. Everything that is a
 * *tenant's* — the token, the username, the webhook secret — comes from the
 * integration row and the Credential Vault, through
 * {@link BotIntegrationDirectory}.
 *
 * **No client is cached.** Building one is cheap and the token is not: caching
 * would keep a revoked or rotated token working, and it would skip the audit
 * row that every vault decryption writes (ADR-0026 decision 5, F-1215). A
 * cached client is a credential held for an unbounded time with nothing
 * recording that it was held, so each send resolves the token again.
 *
 * A token never leaves this class: callers hand over an integration and are
 * handed a driver, or they ask a question and are told the answer (F-323).
 */
@Injectable()
export class BotClientRegistry {
  private readonly logger = new Logger(BotClientRegistry.name);
  private readonly shapes: Record<BotPlatform, PlatformShape>;

  constructor(
    private readonly config: ConfigService,
    @Inject(BOT_INTEGRATION_DIRECTORY)
    private readonly directory: BotIntegrationDirectory,
  ) {
    const base = (key: string, fallback: string) =>
      // A trailing slash would build `…//bot<token>/…`, which some API hosts
      // (and proxies in front of them) answer with 404.
      this.config.get<string>(key, fallback).replace(/\/+$/, '');

    this.shapes = {
      telegram: {
        apiBase: base('TELEGRAM_API_BASE', 'https://api.telegram.org'),
        deepLinkBase: base('TELEGRAM_DEEP_LINK_BASE', DEEP_LINK_BASE.telegram),
      },
      bale: {
        apiBase: base('BALE_API_BASE', 'https://tapi.bale.ai'),
        deepLinkBase: base('BALE_DEEP_LINK_BASE', DEEP_LINK_BASE.bale),
      },
    };
  }

  /**
   * The integration an inbound update belongs to (F-320).
   *
   * The path is the credential lookup: resolving it yields the tenant and the
   * platform, and nothing about the sender is trusted before that. `null` is
   * the only failure — the caller answers 404 to an unknown path and to a
   * route that does not exist alike, so neither can be told from the other.
   */
  byWebhookPath(
    platform: BotPlatform,
    webhookPath: string,
  ): Promise<BotIntegration | null> {
    return this.directory.byWebhookPath(platform, webhookPath);
  }

  /** The bot a tenant sends transactional traffic as (C-05). */
  primaryFor(
    tenantId: string,
    platform: BotPlatform,
  ): Promise<BotIntegration | null> {
    return this.directory.primaryFor(tenantId, platform);
  }

  /**
   * A driver for this integration, or `null` when its token is not usable.
   *
   * `caller` names the code path about to send, and is what the vault's audit
   * row records — `'messenger:BotDispatcher'`, `'identity:TelegramOtpSender'`.
   */
  async client(
    integration: BotIntegration,
    caller: string,
  ): Promise<TelegramLikeBotClient | null> {
    const token = await this.directory.token(integration, caller);
    if (!token) {
      this.logger.warn(
        `${integration.platform}: integration ${integration.id} has no usable token`,
      );
      return null;
    }
    return new TelegramLikeBotClient(
      integration.platform,
      this.shapes[integration.platform].apiBase,
      token,
      this.config.get<number>('OTP_BOT_HTTP_TIMEOUT_MS', 5000),
    );
  }

  /** The tenant's primary bot on this platform, as a driver. */
  async primaryClient(
    tenantId: string,
    platform: BotPlatform,
    caller: string,
  ): Promise<TelegramLikeBotClient | null> {
    const integration = await this.primaryFor(tenantId, platform);
    return integration ? this.client(integration, caller) : null;
  }

  /** What this platform can do, with the date the claim was verified (F-301). */
  capabilities(platform: BotPlatform): MessengerCapabilities {
    return capabilitiesOf(platform);
  }

  /**
   * Whether this integration has a usable token, without decrypting one.
   *
   * For a caller that already holds the integration — see
   * {@link BotIntegrationDirectory.hasToken} for why this never decrypts.
   */
  hasToken(integration: BotIntegration): Promise<boolean> {
    return this.directory.hasToken(integration);
  }

  /**
   * Whether this tenant's primary bot on this platform can send at all.
   *
   * Asked on every render of the OTP channel list, so it never decrypts —
   * see {@link BotIntegrationDirectory.hasToken}.
   */
  async canSend(tenantId: string, platform: BotPlatform): Promise<boolean> {
    const integration = await this.primaryFor(tenantId, platform);
    return integration ? this.directory.hasToken(integration) : false;
  }

  /**
   * Whether this tenant can run the link flow on this platform at all.
   *
   * Delivering an OTP needs a token; *linking* needs the bot's username too,
   * because without it there is no deep link to send the user to.
   */
  async canLink(tenantId: string, platform: BotPlatform): Promise<boolean> {
    const integration = await this.primaryFor(tenantId, platform);
    if (!integration?.botUsername) return false;
    return this.directory.hasToken(integration);
  }

  /**
   * Is this the integration's webhook secret token? (F-321.)
   *
   * Verified on **every** request, and by fingerprint rather than by
   * decryption — the value is not needed here, only the answer.
   */
  verifyWebhookSecret(
    integration: BotIntegration,
    candidate: string,
  ): Promise<boolean> {
    return this.directory.verifyWebhookSecret(integration, candidate);
  }

  /**
   * Verify a Mini App's `initData` against this integration's bot token
   * (`F-310`, ADR-0017).
   *
   * The token never leaves this unit — a caller hands over the signed string
   * and is told who it names, which is the same shape as every other question
   * asked here. An integration with no usable token cannot have signed
   * anything, so it answers `malformed` rather than pretending the signature
   * was wrong.
   */
  async verifyWebAppInitData(
    integration: BotIntegration,
    initData: string,
    maxAgeSec: number = WEB_APP_INIT_DATA_MAX_AGE_SEC,
  ): Promise<WebAppInitDataResult> {
    const token = await this.directory.token(
      integration,
      'messenger:verifyWebAppInitData',
    );
    if (!token) return { ok: false, reason: 'malformed' };
    return verifyWebAppInitData(
      integration.platform,
      token,
      initData,
      maxAgeSec,
    );
  }

  /** The platform's own deep-link shape, built in one place (`deep-link.ts`). */
  deepLink(integration: BotIntegration, startPayload: string): string | null {
    if (!integration.botUsername) return null;
    return buildDeepLink(
      this.shapes[integration.platform].deepLinkBase,
      integration.botUsername,
      startPayload,
    );
  }
}
