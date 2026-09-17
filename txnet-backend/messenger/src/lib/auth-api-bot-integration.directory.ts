import { RequestHeaders } from '@txnet-backend/shared-core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotIntegration, BotIntegrationDirectory } from './bot-integration';
import { BotPlatform } from './bot-platform';

/**
 * The processes that may ask `auth-service` about bots over the seam, and the
 * name each one's vault audit rows carry (F-1215). Closed, so a caller cannot
 * sign a decryption with a name of its choosing.
 */
export const BOT_DIRECTORY_SEAM_SERVICES = [
  'bot-service',
  'notification-service',
] as const;
export type BotDirectorySeamService =
  (typeof BOT_DIRECTORY_SEAM_SERVICES)[number];

/**
 * `messenger`'s directory, answered by `auth-service` over the internal seam
 * (F-320, ADR-0011), for a process that holds no schema and no vault.
 *
 * It lived in `bot-service` until a second such process needed it
 * (`notification-service`, F-035-e); an app cannot import an app, and a second
 * copy of the one class that fetches plaintext tokens is the copy that drifts.
 * Each app binds it with its own {@link BotDirectorySeamService} name.
 *
 * Every question is one HTTP call to `internal/bot-integrations`, proven by
 * `SERVICE_AUTH_TOKEN`. What is new relative to other seam calls is only that
 * one answer is a credential, which is why that route is service-only and
 * writes a vault audit row naming the service and its caller.
 *
 * **Most failures are `null` or `false`.** An unknown path, a refused token and
 * an `auth-service` that is down are the same answer to a stranger POSTing at
 * the webhook, and telling them apart is what makes a path probeable. They are
 * told apart in the log. {@link primaryFor} is the exception, for the reason
 * it gives.
 */
export class AuthApiBotIntegrationDirectory implements BotIntegrationDirectory {
  protected readonly logger = new Logger(AuthApiBotIntegrationDirectory.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(
    config: ConfigService,
    private readonly service: BotDirectorySeamService,
  ) {
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
   * The tenant's primary bot, or `null` when it has none.
   *
   * **Throws when `auth-service` did not answer.** No stranger reaches this
   * question — the caller already names a tenant — so there is nothing to hide
   * by folding an outage into `null`, and a bulk sender that read "no bot" for
   * "no answer" would fail every recipient of a campaign over one bad minute.
   */
  async primaryFor(
    tenantId: string,
    platform: BotPlatform,
  ): Promise<BotIntegration | null> {
    const answer = await this.request<BotIntegration>('primary', {
      tenantId,
      platform,
    });
    return answer.found ? answer.data : null;
  }

  async token(
    integration: BotIntegration,
    caller: string,
  ): Promise<string | null> {
    const result = await this.post<{ token: string | null }>('token', {
      platform: integration.platform,
      webhookPath: integration.webhookPath,
      caller,
      service: this.service,
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
   * refusal every route on that controller gives, so it is not logged as an
   * error — it is the normal answer to a path nobody registered.
   */
  protected async post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const answer = await this.request<T>(path, body);
      return answer.found ? answer.data : null;
    } catch (err) {
      this.logger.error(
        `bot-integrations/${path} failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** One call: `found: false` on a 404, a throw on anything else that is not an answer. */
  private async request<T>(
    path: string,
    body: unknown,
  ): Promise<{ found: true; data: T } | { found: false }> {
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
      if (response.status === 404) return { found: false };
      const payload = (await response.json()) as { ok?: boolean; data?: T };
      if (!payload?.ok || payload.data === undefined) {
        throw new Error(`auth-api answered ${response.status}`);
      }
      return { found: true, data: payload.data };
    } finally {
      clearTimeout(timer);
    }
  }
}
