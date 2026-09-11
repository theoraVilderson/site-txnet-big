/**
 * F-067-c — **where a cross-domain event goes once the transaction that caused
 * it has committed.**
 *
 * ADR-0021 decided the shape: a producing domain inserts an `outbox_event` row
 * inside the same Postgres transaction that writes the ledger, and a relay
 * reads unpublished rows and publishes them. This file is the half of that the
 * relay and every future consumer must agree on — the routing key and the body
 * — and it lives in `shared-core` for the reason `bot-update.ts` does: the
 * publisher is one Nx app and the consumers will be others, an Nx app cannot
 * import an Nx app, and the alternative is the same wire written twice.
 *
 * **The event id is the idempotency key, and it rides as the AMQP
 * `messageId`.** ADR-0021 buys at-least-once and never exactly-once: the relay
 * can publish a row, fail before it stamps `publishedAt`, and publish it again
 * on the next tick. So a consumer that cannot safely process the same event
 * twice is a bug in the consumer, and `messageId` is what it keys on. Putting
 * it in a property rather than only in the body means a consumer can dedupe
 * before it parses anything.
 *
 * **No consumer exists yet**, because every producing domain (`billing`,
 * `network`, `notification`, `ai`) is `draft`. That is visible rather than
 * silent: every publish is `mandatory`, so an event whose type nothing has
 * bound a queue to is returned by the broker and the relay records
 * `unroutable` on the row instead of stamping it published.
 */

/**
 * Every outbox routing key starts with this. The suffix is the event `type`,
 * so a consumer binds to `outbox.billing.payment.#` and gets exactly the
 * events it asked for off the exchange the rest of automation already uses.
 *
 * The prefix is not decoration: `automation.tick.#`, `otp.delivery.#` and
 * `bot.update.<slot>` are already bound on that exchange, and a bare event
 * type is a string a domain chooses — one day one of them chooses `bot.update`
 * and its events start arriving at a bot consumer.
 */
export const OUTBOX_ROUTING_PREFIX = 'outbox.';

/**
 * One row of the outbox, as it goes on the wire.
 *
 * `payload` is opaque here on purpose. What is in it belongs to the domain
 * that wrote it, and typing it in `shared-core` would make every producing
 * domain's event shape a thing this library has to be released for.
 */
export interface OutboxMessage {
  /** The row's own id. The idempotency key, and the AMQP `messageId`. */
  id: string;
  /** What the event is about: `billing.payment`, `network.config`. */
  aggregate: string;
  /** Which one — the row id inside that aggregate. */
  aggregateId: string;
  /** What happened: `confirmed`, `provisioned`. The routing key suffix. */
  type: string;
  /** When the producing transaction said it happened, not when it was sent. */
  occurredAt: string;
  payload: unknown;
}

/**
 * The routing key one event is published to.
 *
 * A type is validated rather than trusted because it comes out of a database
 * column that a producing domain writes, and AMQP does not refuse a bad
 * routing key — it simply matches nothing. An event published to `outbox.`
 * with an empty type would be unroutable for ever and the row would say
 * nothing about why, which is the failure the whole outbox exists to remove.
 */
export function outboxRoutingKey(type: string): string {
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(type)) {
    throw new Error(
      `outbox event type '${type}' is not a routing-key path ` +
        `(dot-separated words, no spaces, no wildcards)`,
    );
  }
  return `${OUTBOX_ROUTING_PREFIX}${type}`;
}
