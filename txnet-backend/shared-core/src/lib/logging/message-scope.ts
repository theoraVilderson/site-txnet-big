import { RequestHeaders } from '../http/headers';
import { acceptRequestId, runWithRequestId } from './request-scope';

/** The part of an amqplib message this reads; `null` is a cancelled consumer. */
type ScopedMessage = { properties: { headers?: Record<string, unknown> } } | null;

/**
 * Wraps a broker `consume` callback so the message is handled with its
 * `x-request-id` in scope (H13, OPS-1-z) — or a new id when it carries none —
 * so the consumer's log lines and the calls it makes join one `requestId`.
 */
export function inMessageScope<M extends ScopedMessage>(handle: (message: M) => Promise<void>): (message: M) => Promise<void> {
  return (message) => {
    const raw = message?.properties.headers?.[RequestHeaders.requestId];
    return runWithRequestId(acceptRequestId(typeof raw === 'string' ? raw : undefined), () => handle(message));
  };
}
