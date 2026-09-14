import { Module } from '@nestjs/common';

import { PaymentConfirmedConsumer } from './payment-confirmed.consumer';

/**
 * Outbox consumers (ADR-0021, ADR-0045). One today: the payer notice for a late
 * credit (F-067-l). `BrokerService`, `RedisService` and `RealtimePublisher` are
 * global modules.
 */
@Module({ providers: [PaymentConfirmedConsumer] })
export class OutboxModule {}
