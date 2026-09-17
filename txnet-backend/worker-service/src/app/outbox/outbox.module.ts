import { Module } from '@nestjs/common';

import { NotificationCreatedConsumer } from './notification-created.consumer';
import { PaymentConfirmedConsumer } from './payment-confirmed.consumer';
import { PaymentReversedConsumer } from './payment-reversed.consumer';

/**
 * Outbox consumers (ADR-0021, ADR-0045). Three today: the payer notices for a late
 * credit (F-067-l) and for a payment the bank reversed (F-067-m), and a new inbox
 * row pushed to an open panel (F-035-b). `BrokerService`, `RedisService` and `RealtimePublisher` are
 * global modules.
 */
@Module({ providers: [PaymentConfirmedConsumer, PaymentReversedConsumer, NotificationCreatedConsumer] })
export class OutboxModule {}
