import {
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantCapability } from '@txnet-backend/shared-core';
import {
  BOT_DIRECTORY_SEAM_SERVICES,
  BotIntegration,
  isBotPlatform,
} from '@txnet-backend/messenger';
import { ServiceOnlyGuard } from '../common/guards/service-only.guard';
import { TenantAgnostic } from '../tenant/tenant-agnostic.decorator';
import { PrismaBotIntegrationDirectory } from './bot-integration.directory';

/** A tenant id as the column stores it; anything else is a 404, not a database error. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What an integration looks like on the internal seam. Never a credential. */
type BotIntegrationView = BotIntegration;

/**
 * The internal seam `bot-service` resolves its bots through (F-320, ADR-0011).
 *
 * `bot-service` serves the webhook but owns no schema and no vault, so it asks
 * here; since F-035-e so does `notification-service`, which sends campaigns as
 * a tenant's primary bot. The questions: which integration is this path (or
 * this tenant's primary), is this its secret token, and — for a process that
 * has to *send* as that bot — what is its token.
 *
 * **Why a token crosses this seam at all.** F-323 says a bot token is never
 * returned by any API, and that rule is about the tenant and admin surfaces:
 * the value must never be readable by the people who can see the panel. This
 * route is not one of those. It is reachable only with `SERVICE_AUTH_TOKEN`,
 * which already lets its holder bypass the captcha and set the rate-limit
 * subject for every chat on the platform — a strictly larger power than one
 * tenant's bot token. Every call still writes a vault audit row naming
 * `bot-service` as the caller, so the trail F-1215 exists for is unbroken.
 *
 * Every route answers **404** to a caller without that token, and 404 to an
 * unknown path — the same answer a route that does not exist gives, so neither
 * can be told from the other by probing.
 *
 * `@TenantAgnostic` because resolving the tenant is what these routes are
 * *for*: `bot-service` cannot name a tenant it is asking to be told.
 */
@TenantCapability('read')
@Controller('internal/bot-integrations')
@UseGuards(ServiceOnlyGuard)
@TenantAgnostic()
export class BotIntegrationController {
  constructor(private readonly directory: PrismaBotIntegrationDirectory) {}

  /**
   * Every integration whose webhook the platform should be keeping live.
   *
   * `bot-service` boots, asks for this list and registers each one upstream on
   * the tenant's behalf (F-321). No credential is in the answer: the token for
   * each is fetched separately, per bot, through the audited route below.
   */
  @Post('registrable')
  async registrable(): Promise<BotIntegrationView[]> {
    return this.directory.allRegistrable();
  }

  /** What happened when the platform tried to register that bot upstream. */
  @Post('registration-result')
  async registrationResult(
    @Body() body: { platform?: string; webhookPath?: string; ok?: boolean },
  ): Promise<{ recorded: true }> {
    const integration = await this.mustResolve(body.platform, body.webhookPath);
    await this.directory.recordRegistration(integration.id, {
      ok: body.ok === true,
    });
    return { recorded: true };
  }

  /** Which integration owns this inbound path. POST, so no path is ever a GET URL in a log. */
  @Post('resolve')
  async resolve(
    @Body() body: { platform?: string; webhookPath?: string },
  ): Promise<BotIntegrationView> {
    return this.mustResolve(body.platform, body.webhookPath);
  }

  /**
   * A tenant's primary bot on one platform, for a process that sends as it
   * (F-035-e: `notification-service` delivering a campaign). No credential;
   * the token is fetched by the path this answers, through the route below.
   * 404 when the tenant has none, as for an unknown path.
   */
  @Post('primary')
  async primary(
    @Body() body: { tenantId?: string; platform?: string },
  ): Promise<BotIntegrationView> {
    if (
      !body.tenantId ||
      !UUID.test(body.tenantId) ||
      !body.platform ||
      !isBotPlatform(body.platform)
    ) {
      throw new NotFoundException();
    }
    const integration = await this.directory.primaryFor(
      body.tenantId,
      body.platform,
    );
    if (!integration) throw new NotFoundException();
    return integration;
  }

  /**
   * The webhook secret, for the process registering this bot upstream (F-321).
   *
   * Same seam and same reasoning as the token route below: the value goes to
   * the platform, so somebody has to hold it, and every call is audited.
   */
  @Post('webhook-secret')
  async webhookSecret(
    @Body() body: { platform?: string; webhookPath?: string; caller?: string },
  ): Promise<{ secret: string | null }> {
    const integration = await this.mustResolve(body.platform, body.webhookPath);
    const secret = await this.directory.webhookSecret(
      integration,
      `bot-service:${body.caller ?? 'unknown'}`,
    );
    return { secret };
  }

  /** Is there a usable token, asked without decrypting one. */
  @Post('has-token')
  async hasToken(
    @Body() body: { platform?: string; webhookPath?: string },
  ): Promise<{ configured: boolean }> {
    const integration = await this.mustResolve(body.platform, body.webhookPath);
    return { configured: await this.directory.hasToken(integration) };
  }

  /** Is this the secret token that integration's webhook was registered with? */
  @Post('verify-secret')
  async verifySecret(
    @Body() body: { platform?: string; webhookPath?: string; candidate?: string },
  ): Promise<{ valid: boolean }> {
    const integration = await this.mustResolve(body.platform, body.webhookPath);
    const valid = await this.directory.verifyWebhookSecret(
      integration,
      body.candidate ?? '',
    );
    return { valid };
  }

  /**
   * The bot token, for the process that is about to send as this bot.
   *
   * Addressed by webhook path rather than by id, so the caller has to already
   * hold the one thing that proves it is serving that bot's door.
   */
  @Post('token')
  async token(
    @Body()
    body: {
      platform?: string;
      webhookPath?: string;
      caller?: string;
      service?: string;
    },
  ): Promise<{ token: string | null }> {
    const integration = await this.mustResolve(body.platform, body.webhookPath);
    // The caller the audit row records is the *remote* code path, prefixed
    // with the process that asked, so a trail reader can tell a decryption
    // performed in this process from one performed on behalf of another
    // (F-1215). Absent is `bot-service`, the seam's first caller; a name off
    // the closed list is recorded as unknown, never as given.
    const service =
      body.service === undefined
        ? 'bot-service'
        : (BOT_DIRECTORY_SEAM_SERVICES as readonly string[]).includes(body.service)
          ? body.service
          : 'unknown-service';
    const token = await this.directory.token(
      integration,
      `${service}:${body.caller ?? 'unknown'}`,
    );
    return { token };
  }

  private async mustResolve(
    platform: string | undefined,
    webhookPath: string | undefined,
  ): Promise<BotIntegration> {
    if (!platform || !isBotPlatform(platform) || !webhookPath) {
      throw new NotFoundException();
    }
    const integration = await this.directory.byWebhookPath(
      platform,
      webhookPath,
    );
    if (!integration) throw new NotFoundException();
    return integration;
  }
}
