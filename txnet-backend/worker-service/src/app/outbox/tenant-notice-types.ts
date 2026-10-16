import { OutboxEventType } from '@txnet-backend/shared-core';

/**
 * The events `TenantSubscriptionNoticeConsumer` tells, bound to its one queue
 * (`AUTOMATION_TENANT_SUBSCRIPTION_NOTICE_QUEUE`): a tenant's owner's notices,
 * and the person notices of its `PERSON_NOTICES`. A new type is added here and
 * there. Its own file, not the consumer's: `BrokerService` reads the list, and
 * the consumer imports the broker (as `retention-notices.ts`).
 */
export const TENANT_NOTICE_TYPES: readonly OutboxEventType[] = [
  // F-019-c: a reseller's renewal unpaid, or the panel suspended for it.
  OutboxEventType.TENANT_SUBSCRIPTION_PAYMENT_DUE,
  OutboxEventType.TENANT_SUBSCRIPTION_SUSPENDED,
  // F-118-w: a reseller at zero told its platform-panel users are cut — the same owner, the same line.
  OutboxEventType.TENANT_WHOLESALE_UNFUNDED,
  // F-019-v8: its quotas — 80%, 100%, stopped, and the daily digest — the same owner again.
  OutboxEventType.TENANT_QUOTA_ALERT,
  OutboxEventType.TENANT_QUOTA_DIGEST,
  // F-117-d: the platform's staff entered in an emergency, without consent — the same owner, at entry.
  OutboxEventType.TENANT_EMERGENCY_ENTRY,
  // RT-1-e2: a custom domain live, failed its window, or lost its record — the same owner.
  OutboxEventType.TENANT_DOMAIN_NOTICE,
  // F-707-e, F-707-m, F-805-b: a person notice — to each wheel admin, a winner, each person who may confirm a transfer.
  OutboxEventType.TENANT_WHEEL_CAP_NEARING,
  OutboxEventType.LOTTERY_WON,
  OutboxEventType.TRANSFER_PROOF_SENT,
  // F-1003: a user costing more than they pay, to each of the tenant's staff.
  OutboxEventType.ANALYTICS_USER_LOSS,
];
