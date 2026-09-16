import { Injectable } from '@nestjs/common';
import { CredentialUnavailable } from '@txnet-backend/shared-core';

import { GatewayMerchant, type MerchantGatewayRef } from './gateway-merchant';

/**
 * A gateway's webhook signing secret, for one `verifyWebhook` call (F-104-b,
 * ADR-0051 decision 6; served since F-104-c).
 *
 * Read through `GatewayMerchant`, the one door to a gateway's credentials.
 * A gateway with no secret stored — missing, expired or revoked — answers
 * `null`, which the webhook door turns into a 401: an unconfigured gateway is a
 * closed door, never a 500 the provider keeps retrying. Any other vault failure
 * passes through.
 */
@Injectable()
export class WebhookSecretSource {
  constructor(private readonly merchant: GatewayMerchant) {}

  async secretFor(gateway: MerchantGatewayRef): Promise<string | null> {
    try {
      return await this.merchant.webhookSecretFor(gateway);
    } catch (e) {
      if (e instanceof CredentialUnavailable) return null;
      throw e;
    }
  }
}
