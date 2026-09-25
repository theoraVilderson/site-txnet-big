import { OutboxEventType, RequestHeaders, type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { envelopeData } from '../automation/internal-answer';
import { BrokerService } from '../broker/broker.service';
import { RedisService } from '../redis/redis.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { EventNoticeSender } from './event-notice';

/** This consumer's segment of its per-channel markers (ADR-0045, F-067-o). */
const NOTICE_CONSUMER = 'tenant-subscription-notice';

const str = (p: Record<string, unknown>, k: string) => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : null);

/**
 * A credited billing wallet renews its reseller at once (F-019-c, user
 * 2026-09-17): `tenant.billing.credited` -> tenant-service's
 * `POST /api/internal/tenant-subscriptions/:tenantId/renew` (F-018-v). The renewal
 * repeats safely, so there is no marker; a refusal throws and the event
 * dead-letters, and the `tenant_subscription_renewal` sweep stands behind it.
 */
@Injectable()
export class TenantBillingCreditedConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(TenantBillingCreditedConsumer.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly broker: BrokerService,
    config: ConfigService,
  ) {
    this.baseUrl = config.get<string>('TENANT_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 30_000);
  }

  async onApplicationBootstrap() {
    await this.broker.consumeTenantBillingCredited((event) => this.handle(event));
    this.logger.log('consuming tenant.billing.credited to renew at once');
  }

  async handle(event: OutboxMessage): Promise<void> {
    const tenantId = str((event.payload ?? {}) as Record<string, unknown>, 'tenantId');
    if (!tenantId) throw new Error(`outbox event ${event.id} has a payload without its tenant`);
    if (!this.baseUrl) throw new Error('TENANT_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const path = `/api/internal/tenant-subscriptions/${encodeURIComponent(tenantId)}/renew`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`tenant-api answered ${response.status} to ${path}`);
      const outcome = envelopeData(await response.json())?.outcome;
      if (typeof outcome !== 'string') throw new Error(`tenant-api answered ${path} without an 'outcome'`);
      if (outcome === 'renewed') this.logger.log(`tenant ${tenantId} renewed on its credit`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Tell a reseller's owner its renewal is unpaid, or that the panel was
 * suspended for it (F-019-c) — through `EventNoticeSender` (F-067-o): the
 * owner's inbox and bot, each once under its own marker. No live push of its
 * own: the inbox row's `notification.created` already reaches every open
 * device (F-035-b), and no page reads a subscription event.
 */
@Injectable()
export class TenantSubscriptionNoticeConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(TenantSubscriptionNoticeConsumer.name);
  private readonly notices: EventNoticeSender;

  constructor(
    private readonly broker: BrokerService,
    redis: RedisService,
    realtime: RealtimePublisher,
    config: ConfigService,
  ) {
    this.notices = new EventNoticeSender(redis, realtime, config, broker);
  }

  async onApplicationBootstrap() {
    await this.broker.consumeTenantSubscriptionNotices((event) => this.handle(event));
    this.logger.log('consuming tenant.subscription.* for the owner notice');
  }

  async handle(event: OutboxMessage): Promise<void> {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const tenantId = str(p, 'tenantId');
    const ownerUserId = str(p, 'ownerUserId');
    const amount = str(p, 'amount');
    if (!tenantId || !ownerUserId || !amount) throw new Error(`outbox event ${event.id} has a payload without its tenant, owner or amount`);
    const template =
      event.type === OutboxEventType.TENANT_SUBSCRIPTION_PAYMENT_DUE
        ? 'subscriptionPaymentDue'
        : event.type === OutboxEventType.TENANT_SUBSCRIPTION_SUSPENDED
          ? 'subscriptionSuspended'
          : null;
    if (!template) throw new Error(`outbox event ${event.id} is ${event.type}, not a renewal notice`);

    const params: Record<string, string> = { amount };
    if (template === 'subscriptionPaymentDue') {
      params.balance = str(p, 'balance') ?? '0.00';
      params.suspendsAt = str(p, 'suspendsAt') ?? '';
    }
    await this.notices.send({ consumer: NOTICE_CONSUMER, eventId: event.id, person: { tenantId, userId: ownerUserId, template, params } });
  }
}
