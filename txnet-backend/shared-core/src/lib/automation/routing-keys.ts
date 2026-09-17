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

/** Outbox event types (`outbox_event.type`), routed as `outboxRoutingKey(type)`. */
export const OutboxEventType = {
  PAYMENT_CONFIRMED: 'billing.payment.confirmed',
  PAYMENT_REVERSED: 'billing.payment.reversed',
  NOTIFICATION_CREATED: 'notification.created',
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

/** A topic binding matching every routing key under `prefix` (which ends in `.`). */
export const topicBindingAll = (prefix: string): string => `${prefix}#`;
