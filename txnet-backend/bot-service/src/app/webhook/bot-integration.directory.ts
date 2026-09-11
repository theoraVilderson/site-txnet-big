import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BotIntegration,
  BotIntegrationDirectory,
  BotPlatform,
} from '@txnet-backend/messenger';

/**
 * `messenger`'s directory, answered by `auth-service` over the internal seam
 * (F-320, ADR-0011).
 *
 * This service serves the webhook but owns no schema and no vault, so every
 * question here is one HTTP call to `internal/bot-integrations`, proven by
 * `SERVICE_AUTH_TOKEN`. That is the same seam every other domain question the
 * bot asks already goes through; what is new is only that one of the answers
 * is a credential, which is why the route it comes from is service-only and
 * writes a vault audit row naming this service.
 *
 * **Every failure is `null` or `false`.** An unknown path, a refused token and
 * an `auth-service` that is down are the same answer to a stranger POSTing at
 * the webhook, and telling them apart is what makes a path probeable. They are
 * told apart in this service's log and nowhere else.
 */
@Injectable()
export class AuthApiBotIntegrationDirectory implements BotIntegrationDirectory {
  private readonly logger = new Logger(AuthApiBotIntegrationDirectory.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('AUTH_API_BASE_URL', '')
      .replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 8000);
  }

  async byWebhookPath(
    platform: BotPlatform,
    webhookPath: string,
  ): Promise<BotIntegration | null> {
    if (!webhookPath) return null;
    return this.post<BotIntegration>('resolve', { platform, webhookPath });
  }

  /**
   * Not answerable here, and deliberately not proxied.
   *
   * This service only ever sends as the bot an update arrived on — it has an
   * integration in hand before it has anything to say. Asking "which bot does
   * this tenant send OTPs as" is `identity`'s question, and it is asked in the
   * process that owns the schema.
   */
  async primaryFor(): Promise<BotIntegration | null> {
    return null;
  }

  async token(
    integration: BotIntegration,
    caller: string,
  ): Promise<string | null> {
    const result = await this.post<{ token: string | null }>('token', {
      platform: integration.platform,
      webhookPath: integration.webhookPath,
      caller,
    });
    return result?.token ?? null;
  }

  async hasToken(integration: BotIntegration): Promise<boolean> {
    const result = await this.post<{ configured: boolean }>('has-token', {
      platform: integration.platform,
      webhookPath: integration.webhookPath,
    });
    return result?.configured ?? false;
  }

  /**
   * Every bot this service should be keeping a live webhook for (F-321).
   *
   * Not part of {@link BotIntegrationDirectory}: it is this service's boot
   * task, not something `messenger` ever asks. An empty list is what a
   * deployment with no integrations yet looks like, and is not an error.
   */
  async registrable(): Promise<BotIntegration[]> {
    return (await this.post<BotIntegration[]>('registrable', {})) ?? [];
  }

  /** The secret to register this bot's webhook with (F-321). */
  async webhookSecret(integration: BotIntegration): Promise<string | null> {
    const result = await this.post<{ secret: string | null }>(
      'webhook-secret',
      {
        platform: integration.platform,
        webhookPath: integration.webhookPath,
        caller: 'BotWebhookRegistrar',
      },
    );
    return result?.secret ?? null;
  }

  /** Tell `auth-service` how the registration went, so the tenant can see it. */
  async recordRegistration(
    integration: BotIntegration,
    ok: boolean,
  ): Promise<void> {
    await this.post('registration-result', {
      platform: integration.platform,
      webhookPath: integration.webhookPath,
      ok,
    });
  }

  async verifyWebhookSecret(
    integration: BotIntegration,
    candidate: string,
  ): Promise<boolean> {
    if (!candidate) return false;
    const result = await this.post<{ valid: boolean }>('verify-secret', {
      platform: integration.platform,
      webhookPath: integration.webhookPath,
      candidate,
    });
    return result?.valid ?? false;
  }

  /**
   * One call, and `null` for every way it can fail.
   *
   * The envelope is `auth-api`'s standard `{ok, msg, data}`; a 404 is the
   * refusal every route on this controller gives, so it is not logged as an
   * error — it is the normal answer to a path nobody registered.
   */
  private async post<T>(path: string, body: unknown): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(
        `${this.baseUrl}/api/internal/bot-integrations/${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [RequestHeaders.serviceToken]: this.serviceToken,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      if (response.status === 404) return null;
      const payload = (await response.json()) as { ok?: boolean; data?: T };
      if (!payload?.ok) return null;
      return payload.data ?? null;
    } catch (err) {
      this.logger.error(
        `bot-integrations/${path} failed: ${(err as Error).message}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
