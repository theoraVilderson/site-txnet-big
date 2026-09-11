/**
 * F-067-f — **an awaited publish, so a lost one is not a silent one.**
 *
 * A plain `channel.publish` returns nothing the broker said, because AMQP says
 * nothing about a plain publish. A broker that took the frame and then dropped
 * it — a full disk, a queue over its limit, a node failing over — is
 * indistinguishable from one that stored it. For a tick that costs an interval,
 * because the next one comes anyway; for the OTP send F-067-a moves onto this
 * broker it costs a user a code that was never queued.
 *
 * Two answers are needed, not one:
 *
 * - **The confirm** says the broker accepted responsibility for the message.
 * - **The return** says where it went, and confirms do not cover it: AMQP acks a
 *   publish to an exchange with no matching binding just as happily as one that
 *   reached a queue. That is the realistic loss for `auth-service`, which
 *   asserts the exchange but never the queue, so a manual tick published before
 *   `worker-service` has ever booted vanishes with a 200 behind it. Publishing
 *   `mandatory` makes the broker hand such a message back instead.
 *
 * RabbitMQ sends `basic.return` **before** the `basic.ack` for an unroutable
 * mandatory message, so a returned id is already known by the time the confirm
 * callback runs. That ordering is the whole correlation mechanism.
 *
 * It lives in `shared-core` for the reason `schedule.ts` does: `worker-service`
 * and `auth-service` both publish, an Nx app cannot import another Nx app, and
 * the alternative is this rule existing twice. The channel is typed
 * structurally so this library does not take an `amqplib` dependency to
 * describe five fields of one.
 */

/** The publish options this helper passes through, plus the two it sets. */
export type PublishOptions = {
  persistent?: boolean;
  contentType?: string;
  headers?: Record<string, unknown>;
  mandatory?: boolean;
  messageId?: string;
};

/** What the broker hands back when a mandatory message reached no queue. */
export interface ReturnedMessage {
  properties: { messageId?: string };
}

/** The shape of an `amqplib` `ConfirmChannel`, as far as publishing needs it. */
export interface ConfirmingChannel {
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: PublishOptions,
    callback: (err: Error | null) => void,
  ): boolean;
  on(event: 'return', listener: (message: ReturnedMessage) => void): unknown;
}

/**
 * Why a publish is not a delivery. Derived from what the broker did, in the
 * same way `deadLetterRecordOf` derives a dead-letter reason from the message —
 * there is nowhere else for it to come from.
 */
export type PublishFailure = 'nacked' | 'unroutable' | 'timeout';

export class PublishNotConfirmedError extends Error {
  constructor(
    readonly reason: PublishFailure,
    message: string,
  ) {
    super(message);
    this.name = 'PublishNotConfirmedError';
  }
}

export type ConfirmedPublish = (
  exchange: string,
  routingKey: string,
  content: Buffer,
  options?: PublishOptions,
) => Promise<void>;

let sequence = 0;

/** Unique per process and per message; it is correlation, not identity. */
const defaultMessageId = (): string =>
  `${Date.now().toString(36)}-${(sequence++).toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

/**
 * Wrap one confirm channel. Registers a single `return` listener on it, so this
 * is called once per channel and its result reused, never per publish.
 *
 * `timeoutMs` bounds the wait: a broker that has stopped answering must fail
 * the caller rather than hold it for ever. The timer is `unref`ed for the
 * reason the tick consumer's deferral timer is — a publish in flight must not
 * keep a shutting-down process alive.
 */
export function confirmedPublisher(
  channel: ConfirmingChannel,
  timeoutMs: number,
  newMessageId: () => string = defaultMessageId,
): ConfirmedPublish {
  const returned = new Set<string>();
  channel.on('return', (message) => {
    const id = message.properties?.messageId;
    if (id) returned.add(id);
  });

  return (exchange, routingKey, content, options = {}) =>
    new Promise<void>((resolve, reject) => {
      const messageId = options.messageId ?? newMessageId();
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;

      const settle = (err?: PublishNotConfirmedError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        returned.delete(messageId);
        if (err) reject(err);
        else resolve();
      };

      timer = setTimeout(
        () =>
          settle(
            new PublishNotConfirmedError(
              'timeout',
              `the broker did not confirm ${routingKey} within ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );
      timer.unref?.();

      channel.publish(
        exchange,
        routingKey,
        content,
        { ...options, mandatory: true, messageId },
        (err) => {
          if (err) {
            settle(
              new PublishNotConfirmedError(
                'nacked',
                `the broker refused ${routingKey}: ${err.message}`,
              ),
            );
            return;
          }
          if (returned.has(messageId)) {
            settle(
              new PublishNotConfirmedError(
                'unroutable',
                `${routingKey} reached no queue on ${exchange}`,
              ),
            );
            return;
          }
          settle();
        },
      );
    });
}
