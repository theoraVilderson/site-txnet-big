import { TenantType, type Prisma } from '@prisma/client';

/**
 * The platform owner's tenant id (ADR-0142): what every row the platform owns
 * carries, read on the caller's client (`tenant` has no RLS). One tenant is
 * the `platform_owner` (tenant invariant). Not cached here: a caller that asks
 * often keeps the answer itself.
 */
export async function platformTenantIdOf(db: Pick<Prisma.TransactionClient, 'tenant'>): Promise<string> {
  const row = await db.tenant.findFirst({ where: { tenantType: TenantType.platform_owner }, select: { id: true } });
  if (!row) throw new Error('no platform_owner tenant');
  return row.id;
}
