import { Injectable, Logger } from '@nestjs/common';
import { ConfirmationSource, PaymentStatus } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { GatewaySource, MerchantGatewayRef } from '../gateway/gateway-merchant';
import { WebhookSignatureInvalid } from '../gateway/payment-provider';
import { PaymentProviderRegistry } from '../gateway/payment-provider.registry';
import { WebhookSecretSource } from '../gateway/webhook-secret';
import { DepositSettlementService, PAYMENT_SELECT } from './deposit-settlement';

/** A webhook post as the controller hands it over: the bytes that were signed, and the headers. */
export type WebhookPost = {
  rawBody: Buffer;
  headers: Readonly<Record<string, string | string[] | undefined>>;
};

/**
 * `accepted` is 200 — including every signed event nothing was done for.
 * `unauthorized` is 401, `not_found` a neutral 404 (ADR-0051 decisions 1, 2, 4).
 */
export type WebhookAnswer = 'accepted' | 'unauthorized' | 'not_found';

/** The payment column a gateway of this source is named in (ADR-0006). */
export const gatewayColumnOf = (source: GatewaySource) =>
  source === 'platform' ? ('gatewayId' as const) : ('tenantGatewayConfigId' as const);

/**
 * Settling a payment from a provider's signed post (F-104-b, ADR-0051).
 *
 * Runs inside the scope `WebhookGatewayMiddleware` opened: the tenant that owns
 * the gateway, where its secret lives. The order is the whole design:
 *
 * 1. **The signature, before anything is read.** No secret is the same answer
 *    as a bad signature, so an unconfigured gateway is a closed door.
 * 2. **The payment's tenant, from the payment.** One cross-tenant read by
 *    `(gateway column, gatewayTrackingCode)` — unique per ADR-0028 — returns
 *    the row's id and tenant, and nothing else. A platform gateway serves many
 *    tenants, and a granted one settles in the borrower (F-096), so the owner
 *    in scope is not the answer.
 * 3. **The money, in that tenant, through F-092-j's guard.** The row is re-read
 *    on the ordinary pool under RLS, and `DepositSettlementService` flips it by
 *    its own status: a provider retrying a delivered event credits once.
 *
 * **CrossTenantPrismaService, second holder.** Step 2 cannot be scoped: the
 * tenant it returns is the scope. It selects `id` and `tenantId` only.
 */
@Injectable()
export class DepositWebhookService {
  private readonly logger = new Logger(DepositWebhookService.name);

  constructor(
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly prisma: PrismaService,
    private readonly providers: PaymentProviderRegistry,
    private readonly secrets: WebhookSecretSource,
    private readonly settlement: DepositSettlementService,
  ) {}

  async handle(gateway: MerchantGatewayRef, post: WebhookPost): Promise<WebhookAnswer> {
    const provider = this.providers.has(gateway.providerName) ? this.providers.get(gateway.providerName) : null;
    if (!provider || provider.settlement !== 'webhook' || !provider.verifyWebhook) return 'not_found';

    // 1. The signature. Nothing past the gateway row is read before it holds.
    const secret = await this.secrets.secretFor(gateway);
    if (!secret) {
      this.logger.warn(`webhook for gateway ${gateway.gatewayId} refused: no webhook secret configured`);
      return 'unauthorized';
    }
    let event;
    try {
      event = await provider.verifyWebhook({ rawBody: post.rawBody, headers: post.headers, secret });
    } catch (e) {
      if (!(e instanceof WebhookSignatureInvalid)) throw e;
      this.logger.warn(`webhook for gateway ${gateway.gatewayId} refused: ${e.message}`);
      return 'unauthorized';
    }

    if (event.kind === 'ignored') {
      this.logger.debug(`webhook ${event.type} on gateway ${gateway.gatewayId} ignored`);
      return 'accepted';
    }
    if (event.kind === 'pending') return 'accepted';
    if (event.kind === 'paid' && event.received && event.received.currency !== provider.chargeCurrency) {
      // Nothing to value it at: the frozen rate is base -> chargeCurrency. The
      // row stays open for reconciliation and a person (F-104-d).
      this.logger.warn(
        `webhook on gateway ${gateway.gatewayId} reports a receipt in ${event.received.currency}, ` +
          `not ${provider.chargeCurrency}; left unsettled`,
      );
      return 'accepted';
    }

    // 2. Whose payment it is.
    const found = await this.crossTenant.paymentTransaction.findFirst({
      where: { [gatewayColumnOf(gateway.source)]: gateway.gatewayId, gatewayTrackingCode: event.authority },
      select: { id: true, tenantId: true },
    });
    if (!found?.tenantId) {
      // A signed event for a code nobody here minted: another integration on
      // the same provider account, or a payment before this gateway existed.
      this.logger.warn(`webhook on gateway ${gateway.gatewayId} names a code no payment carries`);
      return 'accepted';
    }
    const { id, tenantId } = found;

    // 3. The money, in the payment's tenant.
    await runWithTenant({ id: tenantId }, async () => {
      const payment = await tenantTransaction(this.prisma, (tx) =>
        tx.paymentTransaction.findFirst({ where: { id }, select: PAYMENT_SELECT }),
      );
      if (!payment) return;
      const open = payment.status === PaymentStatus.pending || payment.status === PaymentStatus.expired;
      if (!open) return;
      if (event.kind === 'paid') {
        await this.settlement.creditVerified(
          payment,
          {
            referenceId: event.referenceId,
            cardPan: null,
            ...(event.received ? { received: { ...event.received, decimals: provider.chargeDecimals } } : {}),
          },
          ConfirmationSource.webhook_auto,
        );
      } else if (event.kind === 'reversed') {
        await tenantTransaction(this.prisma, (tx) => this.settlement.closeReversed(tx, payment));
      } else {
        await tenantTransaction(this.prisma, (tx) => this.settlement.closeFailed(tx, payment));
      }
    });
    return 'accepted';
  }
}
