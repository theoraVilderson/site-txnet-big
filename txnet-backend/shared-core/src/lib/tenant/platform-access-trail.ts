import { Prisma } from '@prisma/client';
import type { Request } from 'express';

/**
 * What one request did, as the route names it (F-117-c, ADR-0104 (6)): `act` is
 * the method and the route **template** (`POST /api/…/users/:userId/block`), so
 * the trail groups by act and never holds a query string; `target` is the
 * path's ids other than the reseller's own; `ip` is the caller's address.
 */
export type AccessTrace = { act: string; target: Record<string, string>; ip: string };

/** How the platform's staff got in: the reseller's consent (tier B) or an emergency entry (tier C). */
export type PlatformAccessTier = 'consent' | 'emergency';

/** The trace of a request, built once where the actor is (a controller's `actorOf`). */
export function accessTraceOf(req: Request): AccessTrace {
  const params = (req.params ?? {}) as Record<string, string>;
  const target = Object.fromEntries(Object.entries(params).filter(([name]) => name !== 'tenantId'));
  const template = (req.route as { path?: string } | undefined)?.path ?? req.path;
  return { act: `${req.method} ${template}`, target, ip: req.ip ?? '' };
}

/**
 * One request by the platform's staff among a reseller's people, in that
 * reseller's own `admin_audit_log` (F-117-c, ADR-0104 (6)) — written by the door
 * that admitted it, never by the work: a route added later is recorded without
 * knowing it is. Reads are recorded too (a list viewed is the act). Run it in a
 * `tenantTransaction` bound to the reseller: the table is under RLS.
 *
 * The row is the admission, not the outcome: an act refused after the door
 * (a user not found) still leaves it. The act's own row (`grant_freeze`, …)
 * says what changed, where there is one.
 */
export async function recordPlatformAccess(
  tx: Pick<Prisma.TransactionClient, 'adminAuditLog'>,
  entry: {
    tenantId: string;
    actorUserId: string;
    tier: PlatformAccessTier;
    /** The consent (tier B) or the emergency entry (tier C) it rode on. */
    consentId?: string;
    entryId?: string;
    scope: 'read' | 'act';
    capability: string;
    trace?: AccessTrace;
  },
): Promise<void> {
  const trace = entry.trace ?? { act: 'unknown', target: {}, ip: '' };
  await tx.adminAuditLog.create({
    data: {
      tenantId: entry.tenantId,
      adminId: entry.actorUserId,
      action: 'platform_access',
      targetEntityType: 'tenant',
      targetEntityId: entry.tenantId,
      newValue: {
        tier: entry.tier,
        ...(entry.consentId ? { consentId: entry.consentId } : {}),
        ...(entry.entryId ? { entryId: entry.entryId } : {}),
        scope: entry.scope,
        capability: entry.capability,
        act: trace.act,
        target: trace.target,
      },
      adminIpAddress: trace.ip,
    },
  });
}
