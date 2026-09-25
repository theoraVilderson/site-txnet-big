import { OutboxEventType, type OutboxMessage } from '@txnet-backend/shared-core';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BrokerService } from '../broker/broker.service';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RedisService } from '../redis/redis.service';
import { EventNoticeSender } from './event-notice';

/** This consumer's segment of its per-channel markers (ADR-0045, F-067-o). */
const CONSUMER = 'payment-credited-notify';

/** The part of billing's `billing.payment.confirmed` payload this reads (`DepositSettlementService.publishConfirmed`). */
type PaymentConfirmed = {
  tenantId: string;
  userId: string;
  paymentId: string;
  amountCredited: string;
  gatewayReferenceId: string | null;
  confirmationSource: string;
  /** Where the top-up was started (F-306-a); absent on an event written before it = the panel. */
  channel: string;
  /** The chat that relayed an in-chat payment already showed the result (F-104-m). */
  shownInChat: boolean;
};

/**
 * Tell the payer a late credit landed (F-067-l, ADR-0044 consequences,
 * ADR-0045) — the outbox's first consumer.
 *
 * A credit is **late** when anything but the payer's own browser brought it:
 * reconciliation retrying a verifying payment, or a person confirming one. A
 * `webhook_auto` credit is acknowledged and nothing is sent — that payer is
 * looking at the success page already — **unless the top-up was started in the
 * bot** (F-306-a): the bank's page sent that payer to a browser, and the chat
 * they paid from is where they wait for the answer. And not when the event says
 * `shownInChat` (F-104-m): the bot relayed that payment's `successful_payment`
 * and answered in the chat itself, so a notice would be the same news twice.
 *
 * Told through `EventNoticeSender` (F-067-o, ADR-0084): the live event on
 * the payer's own `user:` channel (the top bar re-reads the balance on it),
 * then the payer's inbox, then their bot — each once, under its own marker.
 */
@Injectable()
export class PaymentConfirmedConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentConfirmedConsumer.name);
  private readonly notices: EventNoticeSender;

  constructor(
    private readonly broker: BrokerService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimePublisher,
    config: ConfigService,
  ) {
    this.notices = new EventNoticeSender(redis, realtime, config);
  }

  async onApplicationBootstrap() {
    await this.broker.consumePaymentConfirmed((event) => this.handle(event));
    this.logger.log('consuming billing.payment.confirmed for the payer notice');
  }

  async handle(event: OutboxMessage): Promise<void> {
    const payment = paymentOf(event);
    if (payment.shownInChat) return;
    if (payment.confirmationSource === 'webhook_auto' && payment.channel !== 'bot') return;

    await this.notices.send({
      consumer: CONSUMER,
      eventId: event.id,
      live: {
        channel: `user:${payment.userId}`,
        body: { type: OutboxEventType.PAYMENT_CONFIRMED, paymentId: payment.paymentId, amountCredited: payment.amountCredited },
      },
      person: {
        tenantId: payment.tenantId,
        userId: payment.userId,
        template: 'paymentCredited',
        params: { amount: payment.amountCredited, reference: payment.gatewayReferenceId ?? '' },
      },
    });
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
  return {
    tenantId,
    userId,
    paymentId,
    amountCredited,
    gatewayReferenceId: str('gatewayReferenceId'),
    confirmationSource,
    channel: str('channel') ?? 'panel',
    shownInChat: p['shownInChat'] === true,
  };
}
