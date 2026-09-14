import { Module } from '@nestjs/common';

import { PaymentConfirmedConsumer } from './payment-confirmed.consumer';
import { PaymentReversedConsumer } from './payment-reversed.consumer';

/**
 * Outbox consumers (ADR-0021, ADR-0045). Two today: the payer notices for a late
 * credit (F-067-l) and for a payment the bank reversed (F-067-m). `BrokerService`, `RedisService` and `RealtimePublisher` are
 * global modules.
 */
@Module({ providers: [PaymentConfirmedConsumer, PaymentReversedConsumer] })
export class OutboxModule {}
