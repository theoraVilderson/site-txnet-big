import { TenantType, type Prisma } from '@prisma/client';

/**
 * The tenant type and the backend's one "is this the platform" question
 * (C-18, CS-1-c). A caller imports the question; a type compared at a call
 * site is the question asked again, and each copy drifts on its own.
 */

/** The platform's own tenant type, for data that names one (a query, a decision's source). */
export const PLATFORM_TENANT_TYPE = TenantType.platform_owner;

/** Is this the platform's own tenant, not a reseller's? A tenant nobody found is neither. */
export function isPlatformTenant(type: TenantType | null | undefined): boolean {
  return type === PLATFORM_TENANT_TYPE;
}

/**
 * The platform owner's tenant id (ADR-0142): what every row the platform owns
 * carries, read on the caller's client (`tenant` has no RLS). One tenant is
 * the platform's (tenant invariant). Not cached here: a caller that asks
 * often keeps the answer itself.
 */
export async function platformTenantIdOf(db: Pick<Prisma.TransactionClient, 'tenant'>): Promise<string> {
  const row = await db.tenant.findFirst({ where: { tenantType: PLATFORM_TENANT_TYPE }, select: { id: true } });
  if (!row) throw new Error('no platform tenant');
  return row.id;
}
