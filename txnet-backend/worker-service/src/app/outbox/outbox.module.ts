import { Module } from '@nestjs/common';

import { NotificationCreatedConsumer } from './notification-created.consumer';
import { PaymentConfirmedConsumer } from './payment-confirmed.consumer';
import { PaymentReversedConsumer } from './payment-reversed.consumer';
import { TenantCampaignStopConsumer } from './tenant-campaign-stop.consumer';
import { TenantBillingCreditedConsumer, TenantSubscriptionNoticeConsumer } from './tenant-renewal.consumers';

/**
 * Outbox consumers (ADR-0021, ADR-0045): the payer notices for a late
 * credit (F-067-l) and for a payment the bank reversed (F-067-m), a new inbox
 * row pushed to an open panel (F-035-b), and a reseller's renewal on a credit
 * and its owner's renewal notices (F-019-c),
 * and a reseller's campaigns stopped with its suspension (F-018-q). `BrokerService`, `RedisService` and `RealtimePublisher` are
 * global modules.
 */
@Module({ providers: [PaymentConfirmedConsumer, PaymentReversedConsumer, NotificationCreatedConsumer, TenantBillingCreditedConsumer, TenantSubscriptionNoticeConsumer, TenantCampaignStopConsumer] })
export class OutboxModule {}
