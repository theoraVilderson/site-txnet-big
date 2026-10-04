import type { PrismaClient, SupportConsentScope } from '@prisma/client';

/** The hard cap on one grant (catalog §3.7); the migration's CHECK holds the same number. */
export const SUPPORT_CONSENT_MAX_HOURS = 24;
/** A grant's length when the reseller set no default of its own. */
export const SUPPORT_CONSENT_DEFAULT_HOURS = 4;

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
