import type { PrismaClient, SupportConsentScope } from '@prisma/client';

import { holdsPermission } from '../http/permissions';

/** The hard cap on one grant (catalog §3.7); the migration's CHECK holds the same number. */
export const SUPPORT_CONSENT_MAX_HOURS = 24;
/** A grant's length when the reseller set no default of its own. */
export const SUPPORT_CONSENT_DEFAULT_HOURS = 4;

/**
 * Tier C (F-117-d, ADR-0104 (5)): the permission of its own an emergency entry
 * needs, beside the platform staff's `platform.tenant.manage`; its fixed length; and the
 * least a reason may say. No extension: a new entry once this one has ended.
 */
export const EMERGENCY_ENTRY_PERMISSION = 'tenant.emergency_access';
export const EMERGENCY_ENTRY_HOURS = 1;
export const EMERGENCY_REASON_MIN = 20;

export type LiveSupportConsent = { id: string; scope: SupportConsentScope; expiresAt: Date };

/**
 * The reseller's live consent for the platform's staff, or null (F-117-a,
 * ADR-0104 (4)): granted, not revoked, not yet expired. **The one reader every
 * door uses** — support's platform inbox (F-033-l), and `ResellerAccess` once
 * F-117-b lands — so "live" means one thing everywhere. Read it on every
 * request: a revoke takes effect on the next one, never at the next sign-in.
 *
 * Run it inside the reseller's tenant scope (RLS), as `ResellerAccess.run` and
 * `runWithTenant` leave it. The newest grant wins if two ever overlap.
 */
export async function liveSupportConsent(
  db: Pick<PrismaClient, 'supportAccessConsent'>,
  tenantId: string,
  now = new Date(),
): Promise<LiveSupportConsent | null> {
  const row = await db.supportAccessConsent.findFirst({
    where: { tenantId, grantedAt: { not: null }, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { grantedAt: 'desc' },
    select: { id: true, scope: true, expiresAt: true },
  });
  return row && row.expiresAt ? { id: row.id, scope: row.scope, expiresAt: row.expiresAt } : null;
}

export type LiveEmergencyEntry = { id: string; expiresAt: Date };

/** Whether the caller may open or use an emergency entry: the one check, spelled once. */
export function mayEnterEmergency(permissions: string[]): boolean {
  return holdsPermission(permissions, EMERGENCY_ENTRY_PERMISSION);
}

/**
 * This staff member's running emergency entry into the reseller, or null
 * (F-117-d, ADR-0104 (5)): not ended, not past its hour, **and** the caller
 * still holds {@link EMERGENCY_ENTRY_PERMISSION} — taking the permission away
 * ends the entry on the next request. An entry admits its entrant alone. Read
 * it, as {@link liveSupportConsent}, in the reseller's tenant scope, on every
 * request.
 */
export async function liveEmergencyEntry(
  db: Pick<PrismaClient, 'emergencyAccessEntry'>,
  tenantId: string,
  actor: { userId: string; permissions: string[] },
  now = new Date(),
): Promise<LiveEmergencyEntry | null> {
  if (!mayEnterEmergency(actor.permissions)) return null;
  return db.emergencyAccessEntry.findFirst({
    where: { tenantId, userId: actor.userId, endedAt: null, expiresAt: { gt: now } },
    orderBy: { startedAt: 'desc' },
    select: { id: true, expiresAt: true },
  });
}
