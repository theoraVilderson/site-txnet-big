import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * The request a unit of work belongs to, carried rather than passed (H13,
 * `platform/hosting/contract.md`) — the same mechanism as the tenant scope
 * (ADR-0024), kept apart from it because a request id exists before a tenant
 * is resolved and on routes that never resolve one.
 */
interface RequestScope {
  requestId: string;
  /** The gate's `X-User-Id`, when the request came through `forward-auth`. */
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestScope>();

/** H13: 8–128 characters a log query can match and a log line cannot be broken by. */
const ACCEPTED_REQUEST_ID = /^[A-Za-z0-9-]{8,128}$/;

/** The caller's id when it fits H13, else a new UUID v4 — never a value a client chose freely. */
export function acceptRequestId(raw: string | undefined): string {
  return raw !== undefined && ACCEPTED_REQUEST_ID.test(raw) ? raw : randomUUID();
}

/** Run `fn` with `requestId` (and the caller, when known) in scope. Opened once per request or message, at the edge. */
export function runWithRequestId<T>(requestId: string, fn: () => T, userId?: string): T {
  return storage.run({ requestId, userId }, fn);
}

/** The request id in scope, or `undefined` outside a request (boot, a timer). */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** The user the request was opened for, or `undefined`. */
export function currentRequestUserId(): string | undefined {
  return storage.getStore()?.userId;
}
