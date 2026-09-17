import { OutboxEventType, RedisTtl, RequestHeaders, UnscopedRedisKeys, type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { envelopeData } from '../automation/internal-answer';
import { BrokerService } from '../broker/broker.service';
import { RedisService } from '../redis/redis.service';
import { UserNoticeSender } from './user-notice';

/** This consumer's segment of the processed-event key (ADR-0045). */
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
 * suspended for it (F-019-c) — through auth-service's notice seam, which
 * renders the owner's language and writes the inbox copy. Once per event: the
 * marker is `SET NX` first and given back if the send throws.
 */
@Injectable()
export class TenantSubscriptionNoticeConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(TenantSubscriptionNoticeConsumer.name);
  private readonly notices: UserNoticeSender;

  constructor(
    private readonly broker: BrokerService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.notices = new UserNoticeSender(config);
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

    const marker = UnscopedRedisKeys.outboxProcessed(NOTICE_CONSUMER, event.id);
    if (!(await this.redis.setNx(marker, RedisTtl.outboxProcessed))) {
      this.logger.debug(`outbox event ${event.id} already handled`);
      return;
    }
    try {
      const params: Record<string, string> = { amount };
      if (template === 'subscriptionPaymentDue') {
        params.balance = str(p, 'balance') ?? '0.00';
        params.suspendsAt = str(p, 'suspendsAt') ?? '';
      }
      await this.notices.send({ tenantId, userId: ownerUserId, template, params });
    } catch (err) {
      await this.redis.del(marker);
      throw err;
    }
  }
}
