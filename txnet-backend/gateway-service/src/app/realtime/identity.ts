import type { IncomingMessage } from 'node:http';

import {
  AUTH_ANONYMOUS_HEADER,
  FORWARDED_FOR_HEADER,
  IdentityHeaders,
  headerValue,
} from '@txnet-backend/shared-core';

import type { ConnectionIdentity } from './channel';

/**
 * What the gate decided about one upgrade. `identity` is `null` for a caller
 * that presented no credential and was admitted anyway.
 */
export interface Admission {
  identity: ConnectionIdentity | null;
}

/**
 * Who — if anyone — is on the other end of an upgrade request. `null` means
 * refuse the upgrade.
 *
 * `forward-auth` has already made the decision (`platform/forward-auth/
 * contract.md`); Traefik forwards the answer as headers and strips any the
 * client tried to set. This process therefore reads the decision and never
 * makes one — it holds no `JWT_SECRET`, by the same rule `bot-service` follows
 * (ADR-0009).
 *
 * There are three outcomes, and the middle one is what ADR-0031 added:
 *
 * - **identity headers present** — a signed-in caller. Unchanged.
 * - **`X-Auth-Anonymous: true`** — the gate ran and nobody was signed in. A
 *   real connection with no identity, which may subscribe only to channels it
 *   can prove per subscription (`channel.ts`).
 * - **neither** — refuse. A request arriving with no word from the gate did
 *   not come through it: either the Traefik router lost its middleware or
 *   something reached the container directly on the private network.
 *
 * **The marker is why the third case is still distinguishable.** Without it,
 * "nobody is signed in" and "the gate never ran" are the same thing here — an
 * upgrade with no identity headers — and a router that silently lost its
 * middleware would turn every authenticated socket into an anonymous one. A
 * user would see a panel that has quietly stopped updating rather than an
 * error, which is the failure mode this whole unit is built to avoid.
 */
export function admissionFrom(req: IncomingMessage): Admission | null {
  const identity = identityFrom(req);
  if (identity) return { identity };
  if (header(req, AUTH_ANONYMOUS_HEADER) === 'true') return { identity: null };
  return null;
}

/**
 * The identity headers, or `null` when they are not all there.
 *
 * All-or-nothing on purpose: a partial set is a misconfiguration, never a
 * partially-trusted caller.
 */
export function identityFrom(req: IncomingMessage): ConnectionIdentity | null {
  const userId = header(req, IdentityHeaders.userId);
  const tenantId = header(req, IdentityHeaders.tenantId);
  // Not optional, and it is the one that is easy to get wrong: it is newer
  // than the others (F-067-h added it), so a deployment whose Traefik
  // `authResponseHeaders` list was not updated forwards every other header
  // and drops this one. Without it the session can never be re-checked and
  // the connection would outlive a revocation for ever — silently, since
  // everything else about the socket still works.
  const sessionId = header(req, IdentityHeaders.sessionId);
  if (!userId || !tenantId || !sessionId) return null;

  const permissions = (header(req, IdentityHeaders.permissions) ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');

  return { userId, tenantId, sessionId, permissions };
}

/**
 * The address this upgrade came from, for the anonymous connection cap.
 *
 * `X-Forwarded-For` is set by Traefik, which is the only thing that can reach
 * this port; its first entry is the client. It is forgeable by anything that
 * bypasses Traefik, and that is acceptable for what it is used for — a cap on
 * anonymous sockets, not an authorization input. The socket address is the
 * fallback, and it is Traefik's own in the normal path, which is why it is not
 * the first choice: it would put every anonymous connection in the platform
 * into one bucket.
 */
export function clientAddressOf(req: IncomingMessage): string {
  const forwarded = header(req, FORWARDED_FOR_HEADER);
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * One header off an upgrade request.
 *
 * Names arrive in the casing `contracts/http/wire.json` declares — the
 * spelling `auth-handler` writes and Traefik's lists have to match — while
 * Node lowercases everything it hands back. `headerValue` bridges the two, so
 * nothing in this file spells a header name a second time (C-04).
 */
function header(req: IncomingMessage, name: string): string | undefined {
  return headerValue(req.headers, name);
}
