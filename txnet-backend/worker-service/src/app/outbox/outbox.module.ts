import { Module } from '@nestjs/common';

import { GrantCreatedConsumer } from './grant-created.consumer';
import { GrantDeliveryConsumer } from './grant-delivery.consumer';
import { NoticeFlushConsumer } from './notice-flush.consumer';
import { NotificationCreatedConsumer } from './notification-created.consumer';
import { PanelTestedConsumer } from './panel-tested.consumer';
import { PaymentConfirmedConsumer } from './payment-confirmed.consumer';
import { PaymentReversedConsumer } from './payment-reversed.consumer';
import { TenantBillingCreditedConsumer, TenantSubscriptionNoticeConsumer } from './tenant-renewal.consumers';

/**
 * Outbox consumers (ADR-0021, ADR-0045). Every notice goes through one
 * `EventNoticeSender` (F-067-o, ADR-0084): the payer notices for a late
 * credit (F-067-l) and for a payment the bank reversed (F-067-m), a new inbox
 * row pushed to an open panel (F-035-b), a connection test's verdict pushed to
 * the systems page (F-027-bs), a purchase delivered at once (F-114-i), and a reseller's renewal on a credit
 * and its owner's renewal notices (F-019-c),
 * and a reseller's campaigns stopped with its suspension (F-018-q). Inbox and
 * bot notices are combined per recipient and template, told by
 * `NoticeFlushConsumer` after the window (F-067-p). `BrokerService`, `RedisService` and `RealtimePublisher` are
 * global modules.
 */
@Module({ providers: [PaymentConfirmedConsumer, PaymentReversedConsumer, NotificationCreatedConsumer, PanelTestedConsumer, TenantBillingCreditedConsumer, TenantSubscriptionNoticeConsumer, GrantCreatedConsumer, GrantDeliveryConsumer, NoticeFlushConsumer] })
export class OutboxModule {}
