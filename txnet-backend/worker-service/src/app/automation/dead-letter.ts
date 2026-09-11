import { ATTEMPTS_HEADER, DeadMessage } from '../broker/broker.service';
import { MAX_DEFERRALS } from './tenant-concurrency.gate';

/**
 * Why a message stopped. Three values, because three code paths in this
 * service end a message, and an operator's first question is which one.
 *
 * It is derived from the message itself rather than told to us, and that is
 * the decision this file turns on. A consumer cannot annotate a message it
 * rejects — AMQP carries nothing back through a `nack` — so the alternative
 * was to publish our own copy to the dead-letter exchange and ack the
 * original, which loses the message for good if that publish is the thing that
 * fails (publisher confirms are F-067-f, and are not here yet). Rejecting the
 * message and letting the broker move it is atomic; everything below is what
 * can honestly be read off the result.
 */
export type DeadLetterReason = 'handler_failed' | 'unparseable' | 'gate_gave_up';

/** One row of `automation.dead_letter`, minus the id and the clock. */
export interface DeadLetterRecord {
  /** `automation.tick.<key>` — the address the message was published to. */
  routingKey: string;
  /** The worker it belonged to, from the body or the routing key. */
  workerKey: string | null;
  reason: DeadLetterReason;
  /** How many times it was published or dead-lettered before this. */
  attempts: number;
  /** One line an operator reads first: which queue, and what the broker said. */
  detail: string;
  /** The body, when it was JSON. */
  payload: unknown | null;
  /** The body as text, only when it was not — never both. */
  rawPayload: string | null;
}

interface XDeath {
  count?: number;
  reason?: string;
  queue?: string;
}

/**
 * Turn a dead message into the row that records it.
 *
 * Pure, and total: every branch produces a record. A message that cannot be
 * classified is still a message that has to be written down — the whole point
 * of the table is that nothing leaves the queue unaccounted for, and a
 * classifier that threw would be one more way to lose one.
 */
export function deadLetterRecordOf(
  message: Pick<DeadMessage, 'routingKey'> & {
    content: Buffer | string;
    headers?: Record<string, unknown>;
  },
): DeadLetterRecord {
  const headers = message.headers ?? {};
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content.toString('utf8');

  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    payload =
      parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null;
  } catch {
    payload = null;
  }

  const death = firstDeath(headers);
  const deferrals =
    payload && typeof payload.deferrals === 'number' ? payload.deferrals : 0;

  const reason: DeadLetterReason = !payload
    ? 'unparseable'
    : deferrals >= MAX_DEFERRALS
      ? 'gate_gave_up'
      : 'handler_failed';

  return {
    routingKey: message.routingKey,
    workerKey: workerKeyOf(payload, message.routingKey),
    reason,
    attempts: attemptsOf(headers, death),
    detail: detailOf(reason, death, deferrals),
    payload,
    // Only when it did not parse. Keeping both would store the same bytes
    // twice, and the raw copy exists exactly because there is no parsed one.
    rawPayload: payload ? null : text,
  };
}

/**
 * The body's own `key` first, the routing key second. A producer that is not
 * a tick — an outbox event, a bot update — has no `key` field, and the routing
 * key is then the only address the row can be attributed by.
 */
function workerKeyOf(
  payload: Record<string, unknown> | null,
  routingKey: string,
): string | null {
  if (payload && typeof payload.key === 'string' && payload.key) {
    return payload.key;
  }
  const suffix = routingKey.startsWith('automation.tick.')
    ? routingKey.slice('automation.tick.'.length)
    : '';
  return suffix || null;
}

/**
 * The larger of the two counters, floored at one.
 *
 * They count different things — `x-attempts` counts our publishes, so a
 * deferred tick carries one per yield; the broker's `x-death` counts
 * dead-letterings of this routing key — and neither is a superset of the
 * other. Taking the larger keeps the pathological case looking pathological,
 * which is the reason an attempt count is on the message at all.
 */
function attemptsOf(
  headers: Record<string, unknown>,
  death: XDeath | null,
): number {
  const stamped = headers[ATTEMPTS_HEADER];
  const published = typeof stamped === 'number' ? stamped : 0;
  const dead = typeof death?.count === 'number' ? death.count : 0;
  return Math.max(published, dead, 1);
}

function firstDeath(headers: Record<string, unknown>): XDeath | null {
  const deaths = headers['x-death'];
  if (!Array.isArray(deaths) || deaths.length === 0) return null;
  const first: unknown = deaths[0];
  return first && typeof first === 'object' ? (first as XDeath) : null;
}

function detailOf(
  reason: DeadLetterReason,
  death: XDeath | null,
  deferrals: number,
): string {
  const where = death?.queue ? ` out of ${death.queue}` : '';
  const said = death?.reason ? `${death.reason}` : 'rejected';
  const why =
    reason === 'gate_gave_up'
      ? ` — the tenant gate gave up after ${deferrals} deferrals (cap ${MAX_DEFERRALS})`
      : reason === 'unparseable'
        ? ' — the body is not JSON; the run log has nothing about it'
        : ' — the handler threw; its run is a bot_execution_log row with status failed';
  return `${said}${where}${why}`;
}
