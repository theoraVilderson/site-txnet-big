import { RedisTtl, UnscopedRedisKeys, type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BrokerService } from '../broker/broker.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';
import { UserNoticeSender } from './user-notice';

/** This consumer's segment of the processed-event key — not the credited notice's (ADR-0045). */
const CONSUMER = 'payment-reversed-notify';

/** The part of billing's `billing.payment.reversed` payload this reads (`DepositSettlementService.closeReversed`). */
type PaymentReversed = { tenantId: string; userId: string; paymentId: string; amountCredited: string };

/**
 * Tell the payer the bank is returning a payment the gateway reversed
 * (F-067-m, ADR-0046 decision 5).
 *
 * The credited notice's rules exactly (ADR-0045): the marker is `SET NX` before
 * any side effect and given back when one throws; the live event on the payer's
 * own `user:` channel, then the bot message through auth-service. Unlike a
 * credit there is no case to skip — nobody watches a reversal happen, and a
 * payer who paid and got nothing must hear why.
 */
@Injectable()
export class PaymentReversedConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentReversedConsumer.name);
  private readonly notices: UserNoticeSender;

  constructor(
    private readonly broker: BrokerService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimePublisher,
    config: ConfigService,
  ) {
    this.notices = new UserNoticeSender(config);
  }

  async onApplicationBootstrap() {
    await this.broker.consumePaymentReversed((event) => this.handle(event));
    this.logger.log('consuming billing.payment.reversed for the payer notice');
  }

  async handle(event: OutboxMessage): Promise<void> {
    const payment = paymentOf(event);

    const marker = UnscopedRedisKeys.outboxProcessed(CONSUMER, event.id);
    if (!(await this.redis.setNx(marker, RedisTtl.outboxProcessed))) {
      this.logger.debug(`outbox event ${event.id} already handled`);
      return;
    }

    try {
      await this.realtime.publish(`user:${payment.userId}`, {
        type: 'billing.payment.reversed',
        paymentId: payment.paymentId,
        amountCredited: payment.amountCredited,
      });
      await this.notices.send({
        tenantId: payment.tenantId,
        userId: payment.userId,
        template: 'paymentReversed',
        params: { amount: payment.amountCredited },
      });
    } catch (err) {
      await this.redis.del(marker);
      throw err;
    }
  }
}

/** The payload, or a throw: an event that does not say whose payment it is is not one to guess about. */
function paymentOf(event: OutboxMessage): PaymentReversed {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === 'string' && p[k] !== '' ? (p[k] as string) : null);
  const tenantId = str('tenantId');
  const userId = str('userId');
  const paymentId = str('paymentId');
  const amountCredited = str('amountCredited');
  if (!tenantId || !userId || !paymentId || !amountCredited) {
    throw new Error(`outbox event ${event.id} has a payload without its tenant, user, payment or amount`);
  }
  return { tenantId, userId, paymentId, amountCredited };
}
