import { RequestHeaders, type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { envelopeData } from '../automation/internal-answer';
import { BrokerService } from '../broker/broker.service';

/**
 * A paid Grant delivered at once (F-114-i, user 2026-09-25):
 * `entitlement.grant.created` -> billing's
 * `POST /api/internal/billing/entitlement/grants/:grantId/deliver`, the same
 * check the `grant_delivery` sweep makes, for this one Grant. A feature is
 * live about a second after the payment instead of up to a minute.
 *
 * Billing checks only a Grant still `pending` and due, so a redelivered event
 * answers `skipped` and moves no clock: **no marker**. A refusal, an unset seam
 * or an unreadable answer throws and the event dead-letters; the minute sweep
 * stands behind it, as `tenant_subscription_renewal` does behind
 * `TenantBillingCreditedConsumer`.
 */
@Injectable()
export class GrantCreatedConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(GrantCreatedConsumer.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly broker: BrokerService,
    config: ConfigService,
  ) {
    this.baseUrl = config.get<string>('BILLING_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('BILLING_API_TIMEOUT_MS', 30_000);
  }

  async onApplicationBootstrap() {
    await this.broker.consumeGrantCreated((event) => this.handle(event));
    this.logger.log('consuming entitlement.grant.created to deliver at once');
  }

  async handle(event: OutboxMessage): Promise<void> {
    const grantId = (event.payload as Record<string, unknown> | null)?.['grantId'];
    if (typeof grantId !== 'string' || grantId === '') throw new Error(`outbox event ${event.id} has a payload without its Grant`);
    if (!this.baseUrl) throw new Error('BILLING_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const path = `/api/internal/billing/entitlement/grants/${encodeURIComponent(grantId)}/deliver`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`billing answered ${response.status} to ${path}`);
      const outcome = envelopeData(await response.json())?.outcome;
      if (typeof outcome !== 'string') throw new Error(`billing answered ${path} without an 'outcome'`);
      if (outcome === 'delivered' || outcome === 'refunded') this.logger.log(`grant ${grantId} ${outcome} on its purchase`);
    } finally {
      clearTimeout(timer);
    }
  }
}
