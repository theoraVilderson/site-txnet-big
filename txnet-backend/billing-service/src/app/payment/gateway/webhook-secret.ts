import { Injectable } from '@nestjs/common';

import type { MerchantGatewayRef } from './gateway-merchant';

/**
 * A gateway's webhook signing secret, for one `verifyWebhook` call (F-104-b,
 * ADR-0051 decision 6).
 *
 * **Closed until F-104-c.** The vault kind exists, but nothing stores a gateway's
 * secret under it yet, so this answers `null` for every gateway and the webhook
 * door refuses every post as unsigned. F-104-c replaces the body with a
 * `GatewayMerchant` read; the port stays, so the door does not change.
 */
@Injectable()
export class WebhookSecretSource {
  async secretFor(_gateway: MerchantGatewayRef): Promise<string | null> {
    return null;
  }
}
