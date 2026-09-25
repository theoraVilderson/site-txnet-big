/**
 * Every routing key and outbox event type that more than one process spells
 * (C-08).
 *
 * The publisher and the binder of one key are always in different Nx apps —
 * `billing-service` writes `billing.payment.confirmed`, `worker-service` binds a
 * queue to it; `auth-service` publishes `automation.tick.<key>` and
 * `otp.delivery.send`, `worker-service` binds `automation.tick.#` and
 * `otp.delivery.#`. A key renamed on one side still publishes: to no queue,
 * with `mandatory` turning it into an `unroutable` nobody reads as a typo. So
 * each is written once, here, beside `BOT_UPDATE_ROUTING_PREFIX` and
 * `OUTBOX_ROUTING_PREFIX`, for the reason those already are.
 */

/**
 * The outbox events a browser also reads off a `user:` channel (or, for
 * `network.panel.tested`, its operator's `tenant:` one), under the same name —
 * held to `contracts/realtime/events.json` (C-08).
 */
export const RealtimeEventType = {
  PAYMENT_CONFIRMED: 'billing.payment.confirmed',
  PAYMENT_REVERSED: 'billing.payment.reversed',
  NOTIFICATION_CREATED: 'notification.created',
  /** F-027-bs: `network-service` wrote a connection test's verdict or fault (`register.PostgresStore`). */
  PANEL_TESTED: 'network.panel.tested',
} as const;

/** Outbox event types (`outbox_event.type`), routed as `outboxRoutingKey(type)`. Only {@link RealtimeEventType} reach a browser. */
export const OutboxEventType = {
  ...RealtimeEventType,
  /** F-019-c: a reseller's billing wallet was credited — its renewal may now be paid (`TenantBillingLedger.credit`). */
  TENANT_BILLING_CREDITED: 'tenant.billing.credited',
  /** F-019-c: a renewal is unpaid and in grace; the owner is warned. */
  TENANT_SUBSCRIPTION_PAYMENT_DUE: 'tenant.subscription.payment_due',
  /** F-019-c: grace ran out and the reseller was suspended for non-payment. */
  TENANT_SUBSCRIPTION_SUSPENDED: 'tenant.subscription.suspended',
  /** F-027-at: the platform owner released a usage hold; `metering-service` bills it (ADR-0080 decision 3). */
  USAGE_RELEASE: 'network.usage.release',
  /** F-111-b: a paid invoice issued a Grant, `pending` until delivery (spec §5.8 step 2). */
  GRANT_CREATED: 'entitlement.grant.created',
} as const;
export type OutboxEventType = (typeof OutboxEventType)[keyof typeof OutboxEventType];

/** Every tick routing key starts with this. The suffix is the worker key. */
export const AUTOMATION_TICK_ROUTING_PREFIX = 'automation.tick.';
export const automationTickRoutingKey = (workerKey: string): string =>
  `${AUTOMATION_TICK_ROUTING_PREFIX}${workerKey}`;

/** Every OTP delivery routing key starts with this. */
export const OTP_DELIVERY_ROUTING_PREFIX = 'otp.delivery.';
/** The routing key an OTP send is published under. */
export const OTP_DELIVERY_ROUTING_KEY = `${OTP_DELIVERY_ROUTING_PREFIX}send`;

/**
 * A combined notice's flush (F-067-p, ADR-0084 decision 3). Published to the
 * delay queue under `DELAY`; the broker dead-letters it after the window under
 * `FLUSH`, which the flush queue binds.
 */
export const NOTICE_BURST_DELAY_ROUTING_KEY = 'notice.burst.delay';
export const NOTICE_BURST_FLUSH_ROUTING_KEY = 'notice.burst.flush';

/** A topic binding matching every routing key under `prefix` (which ends in `.`). */
export const topicBindingAll = (prefix: string): string => `${prefix}#`;
