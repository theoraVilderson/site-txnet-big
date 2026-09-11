import { UnauthorizedException } from '@nestjs/common';
import {
  ALWAYS_SET_IDENTITY_HEADERS,
  IdentityHeaders,
  TenantContext,
} from '@txnet-backend/shared-core';
import type { Request, Response } from 'express';

import { IdentityMiddleware, identityOf } from './identity.middleware';

/**
 * The request edge of `billing-service` (F-092-a).
 *
 * The invariant this file holds: a request is only served inside the tenant
 * `forward-auth` proved, and a request carrying no complete proof is refused —
 * never served as "no tenant", and never with a tenant read from half a set.
 * Every money query F-092-b adds runs through `withTenant`, which reads the
 * scope this middleware opens; getting this wrong is a cross-tenant read that
 * no error announces.
 */
const GATE_HEADERS: Record<string, string> = {
  [IdentityHeaders.userId]: 'user-1',
  [IdentityHeaders.tenantId]: 'tenant-a',
  [IdentityHeaders.roleId]: 'role-1',
  [IdentityHeaders.sessionId]: 'session-1',
  [IdentityHeaders.permissions]: 'wallet.read, wallet.topup',
};

/** Node hands headers over lowercased; the fake does the same. */
function requestWith(headers: Record<string, string>): Request {
  const lowered = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return { headers: lowered } as unknown as Request;
}

function run(req: Request): { tenantInScope: string | null; ran: boolean } {
  const seen = { tenantInScope: null as string | null, ran: false };
  new IdentityMiddleware().use(req, {} as Response, () => {
    seen.ran = true;
    seen.tenantInScope = TenantContext.currentOrNull()?.id ?? null;
  });
  return seen;
}

describe('IdentityMiddleware', () => {
  it('serves the request inside the tenant the gate forwarded', () => {
    const req = requestWith(GATE_HEADERS);

    const seen = run(req);

    expect(seen.ran).toBe(true);
    expect(seen.tenantInScope).toBe('tenant-a');
    expect(identityOf(req)).toEqual({
      userId: 'user-1',
      tenantId: 'tenant-a',
      roleId: 'role-1',
      sessionId: 'session-1',
      permissions: ['wallet.read', 'wallet.topup'],
    });
  });

  it('closes the scope with the request', () => {
    run(requestWith(GATE_HEADERS));

    expect(TenantContext.currentOrNull()).toBeNull();
  });

  it('refuses a request the gate never saw', () => {
    // No headers at all: the router lost its middleware, or something reached
    // the container directly on the private network.
    expect(() => run(requestWith({}))).toThrow(UnauthorizedException);
  });

  // Permissions are the one always-set header that may carry nothing, and an
  // empty header reads as absent (`headerValue`) — covered by the last case.
  it.each(
    ALWAYS_SET_IDENTITY_HEADERS.filter((h) => h !== IdentityHeaders.permissions),
  )(
    'refuses a set missing %s rather than trusting the rest',
    (missing) => {
      const partial = { ...GATE_HEADERS };
      delete partial[missing];
      let ran = false;

      expect(() =>
        new IdentityMiddleware().use(requestWith(partial), {} as Response, () => {
          ran = true;
        }),
      ).toThrow(UnauthorizedException);
      expect(ran).toBe(false);
    },
  );

  it('treats an empty tenant header as missing', () => {
    // Compose and Traefik both turn "unset" into `''`; an empty id opened as a
    // scope would bind `app.tenant_id = ''` and read as a real tenant.
    expect(() =>
      run(requestWith({ ...GATE_HEADERS, [IdentityHeaders.tenantId]: '' })),
    ).toThrow(UnauthorizedException);
  });

  it('accepts a signed-in caller with no permissions', () => {
    // The gate writes `X-User-Permissions: ""` for a role with none, and
    // Traefik may drop an empty header on the way: both are an empty list.
    const empty = requestWith({ ...GATE_HEADERS, [IdentityHeaders.permissions]: '' });
    const dropped = { ...GATE_HEADERS };
    delete dropped[IdentityHeaders.permissions];
    const absent = requestWith(dropped);

    expect(run(empty).ran).toBe(true);
    expect(identityOf(empty).permissions).toEqual([]);
    expect(run(absent).ran).toBe(true);
    expect(identityOf(absent).permissions).toEqual([]);
  });
});
