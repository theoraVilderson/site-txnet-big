import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import {
  IdentityHeaders,
  headerValue,
  runWithTenant,
} from '@txnet-backend/shared-core';
import type { NextFunction, Request, Response } from 'express';

/**
 * Who `forward-auth` proved is on the other end of a request.
 *
 * The five headers a successful `/validate` always carries
 * (`platform/forward-auth/contract.md`). Traefik strips any the client tried to
 * set before the gate runs, which is what makes them readable as proof.
 */
export interface RequestIdentity {
  userId: string;
  tenantId: string;
  roleId: string;
  sessionId: string;
  permissions: string[];
}

type IdentifiedRequest = Request & { identity?: RequestIdentity };

/**
 * The identity headers, or `null` when they are not all there.
 *
 * All-or-nothing, as `gateway-service` reads them: a partial set is a
 * misconfiguration — typically a Traefik `authResponseHeaders` list that lost
 * one — never a partially-trusted caller.
 *
 * `X-User-Permissions` is the exception: the gate writes it as `""` for a role
 * with no permissions, and `headerValue` reads an empty header as absent, so
 * its absence is an empty list rather than a refusal — as in `gateway-service`.
 */
export function identityFrom(req: Request): RequestIdentity | null {
  const read = (name: string) => headerValue(req.headers, name);

  const userId = read(IdentityHeaders.userId);
  const tenantId = read(IdentityHeaders.tenantId);
  const roleId = read(IdentityHeaders.roleId);
  const sessionId = read(IdentityHeaders.sessionId);
  if (!userId || !tenantId || !roleId || !sessionId) return null;

  return {
    userId,
    tenantId,
    roleId,
    sessionId,
    permissions: (read(IdentityHeaders.permissions) ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== ''),
  };
}

/**
 * The identity {@link IdentityMiddleware} attached. Throws when there is none,
 * which on a route behind the middleware means a bug in the module wiring, not
 * a caller to answer.
 */
export function identityOf(req: Request): RequestIdentity {
  const identity = (req as IdentifiedRequest).identity;
  if (!identity) {
    throw new Error('No request identity: IdentityMiddleware did not run for this route');
  }
  return identity;
}

/**
 * Opens the tenant scope for the rest of the request (F-092-a, ADR-0024).
 *
 * `notification-service` resolves no tenant of its own. It sits behind `my-auth`, so
 * the tenant is whatever the gate forwarded in `X-Tenant-Id` — the same answer
 * `gateway-service` reads — and the scope carries only that id (`ScopedTenant`,
 * `platform/tenant-context/contract.md`).
 *
 * **Refused, not scoped to `null`.** `auth-service` opens a `null` scope for an
 * unresolved Host because "resolved to nothing" is a real answer there. Here
 * there is no such answer: every route requires a signed-in caller, so a request
 * without the headers did not come through the gate at all. 401 through the
 * envelope, and the filter logs it with a `ref`.
 *
 * `next()` runs *inside* `runWithTenant`, so every guard, pipe, handler and
 * Prisma call downstream reads the scope without being handed it.
 */
@Injectable()
export class IdentityMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const identity = identityFrom(req);
    if (!identity) {
      throw new UnauthorizedException('request carries no forward-auth identity');
    }
    (req as IdentifiedRequest).identity = identity;
    runWithTenant({ id: identity.tenantId }, () => next());
  }
}
