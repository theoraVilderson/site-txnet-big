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

/** The params a quota notice carries through: how to name the quota, and its figures. */
const QUOTA_PARAMS = ['quotaKey', 'productNameKey', 'included', 'unitPrice', 'currencyCode', 'day', 'refused', 'overageUnits', 'overageCost'] as const;

/**
 * A reseller's quota notice (F-019-v8): 80% is `resellerQuotaNearing`; 100%
 * is overage started or stopped, by its mode; `stopped` names why — the
 * reseller's own spend cap, or a wallet that could not pay; the daily digest
 * is `resellerQuotaDigest`. Null: a level this consumer does not know.
 */
export function quotaNotice(type: string, p: Record<string, unknown>): { template: string; params: Record<string, string> } | null {
  const params: Record<string, string> = {};
  for (const k of QUOTA_PARAMS) if (str(p, k)) params[k] = str(p, k)!;
  if (type === OutboxEventType.TENANT_QUOTA_DIGEST) return { template: 'resellerQuotaDigest', params };
  const level = str(p, 'level');
  const template =
    level === '80'
      ? 'resellerQuotaNearing'
      : level === '100'
        ? str(p, 'mode') === 'overage'
          ? 'resellerQuotaOverageStarted'
          : 'resellerQuotaStopped'
        : level === 'stopped'
          ? str(p, 'stoppedBy') === 'spend_cap'
            ? 'resellerQuotaCapReached'
            : 'resellerQuotaUnpaid'
          : null;
  return template ? { template, params } : null;
}

/**
 * Tell a reseller's owner its renewal is unpaid, or that the panel was
 * suspended for it (F-019-c), or that its billing wallet no longer funds its
 * users on platform panels (F-118-w, once per refusal spell) — through `EventNoticeSender` (F-067-o): the
 * owner's inbox and bot, each once under its own marker. Its quotas too
 * (F-019-v8): 80%, 100%, stopped, and the daily digest ({@link quotaNotice}). No live push of its
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
    this.logger.log('consuming tenant.subscription.* and tenant.billing.wholesale_unfunded for the owner notice');
  }

  async handle(event: OutboxMessage): Promise<void> {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const tenantId = str(p, 'tenantId');
    const ownerUserId = str(p, 'ownerUserId');
    if (!tenantId || !ownerUserId) throw new Error(`outbox event ${event.id} has a payload without its tenant or owner`);
    if (event.type === OutboxEventType.TENANT_QUOTA_ALERT || event.type === OutboxEventType.TENANT_QUOTA_DIGEST) {
      const quota = quotaNotice(event.type, p);
      if (!quota) throw new Error(`outbox event ${event.id} is a quota notice auth-service has no words for`);
      await this.notices.send({ consumer: NOTICE_CONSUMER, eventId: event.id, person: { tenantId, userId: ownerUserId, ...quota } });
      return;
    }
    if (event.type === OutboxEventType.TENANT_WHOLESALE_UNFUNDED) {
      await this.notices.send({ consumer: NOTICE_CONSUMER, eventId: event.id, person: { tenantId, userId: ownerUserId, template: 'resellerWholesaleUnfunded', params: {} } });
      return;
    }
    const amount = str(p, 'amount');
    if (!amount) throw new Error(`outbox event ${event.id} has a payload without its amount`);
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
