import { IdentityHeaders, RedisTtl, RequestHeaders, UnscopedRedisKeys, type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BrokerService } from '../broker/broker.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';

/** This consumer's segment of the processed-event key (ADR-0045). */
const CONSUMER = 'payment-credited-notify';

/** auth-service's seam for messaging a user on their linked bot (ADR-0045 decision 2). */
const NOTIFY_PATH = '/api/internal/notify/user';

/** The part of billing's `billing.payment.confirmed` payload this reads (`DepositSettlementService.publishConfirmed`). */
type PaymentConfirmed = {
  tenantId: string;
  userId: string;
  paymentId: string;
  amountCredited: string;
  gatewayReferenceId: string | null;
  confirmationSource: string;
};

/**
 * Tell the payer a late credit landed (F-067-l, ADR-0044 consequences,
 * ADR-0045) — the outbox's first consumer.
 *
 * A credit is **late** when anything but the payer's own browser brought it:
 * reconciliation retrying a verifying payment, or a person confirming one. A
 * `webhook_auto` credit is acknowledged and nothing is sent — that payer is
 * looking at the success page already.
 *
 * **Once, at-least-once delivery notwithstanding.** The marker is `SET NX`
 * before any side effect; a redelivered event finds it and stops. A side
 * effect that throws **deletes the marker** before rethrowing, so the message
 * dead-letters (F-067-d) with the event still owed rather than recorded as
 * handled.
 *
 * Two halves, in this order: the live event on the payer's own `user:` channel
 * (at most once, and the top bar re-reads the balance on it), then the bot
 * message through auth-service, which owns the tenant's bots and the user's
 * linked chats.
 */
@Injectable()
export class PaymentConfirmedConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentConfirmedConsumer.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly broker: BrokerService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimePublisher,
    config: ConfigService,
  ) {
    this.baseUrl = config.get<string>('AUTH_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 30_000);
  }

  async onApplicationBootstrap() {
    await this.broker.consumePaymentConfirmed((event) => this.handle(event));
    this.logger.log('consuming billing.payment.confirmed for the payer notice');
  }

  async handle(event: OutboxMessage): Promise<void> {
    const payment = paymentOf(event);
    if (payment.confirmationSource === 'webhook_auto') return;

    const marker = UnscopedRedisKeys.outboxProcessed(CONSUMER, event.id);
    if (!(await this.redis.setNx(marker, RedisTtl.outboxProcessed))) {
      this.logger.debug(`outbox event ${event.id} already handled`);
      return;
    }

    try {
      await this.realtime.publish(`user:${payment.userId}`, {
        type: 'billing.payment.confirmed',
        paymentId: payment.paymentId,
        amountCredited: payment.amountCredited,
      });
      await this.notify(payment);
    } catch (err) {
      await this.redis.del(marker);
      throw err;
    }
  }

  private async notify(payment: PaymentConfirmed): Promise<void> {
    if (!this.baseUrl) throw new Error('AUTH_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${NOTIFY_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [RequestHeaders.serviceToken]: this.serviceToken,
          [IdentityHeaders.tenantId]: payment.tenantId,
        },
        body: JSON.stringify({
          userId: payment.userId,
          template: 'paymentCredited',
          params: { amount: payment.amountCredited, reference: payment.gatewayReferenceId ?? '' },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`auth-api answered ${response.status} to ${NOTIFY_PATH}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The payload, or a throw: an event that does not say whose payment it is is not one to guess about. */
function paymentOf(event: OutboxMessage): PaymentConfirmed {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : null);
  const tenantId = str('tenantId');
  const userId = str('userId');
  const paymentId = str('paymentId');
  const amountCredited = str('amountCredited');
  const confirmationSource = str('confirmationSource');
  if (!tenantId || !userId || !paymentId || !amountCredited || !confirmationSource) {
    throw new Error(`outbox event ${event.id} has a payload without its tenant, user, payment, amount or source`);
  }
  return { tenantId, userId, paymentId, amountCredited, gatewayReferenceId: str('gatewayReferenceId'), confirmationSource };
}
