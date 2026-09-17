import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuthApiBotIntegrationDirectory,
  BotIntegration,
} from '@txnet-backend/messenger';

/**
 * `messenger`'s seam directory (F-320), plus the three questions only this
 * service asks: which bots to keep a webhook for, with what secret, and how
 * the registration went (F-321). They are this service's boot task, not
 * something `messenger` ever asks, so they stay here rather than in the port.
 */
@Injectable()
export class WebhookBotIntegrationDirectory extends AuthApiBotIntegrationDirectory {
  constructor(config: ConfigService) {
    super(config, 'bot-service');
  }

  /**
   * Every bot this service should be keeping a live webhook for (F-321). An
   * empty list is what a deployment with no integrations yet looks like, and
   * is not an error.
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
}
