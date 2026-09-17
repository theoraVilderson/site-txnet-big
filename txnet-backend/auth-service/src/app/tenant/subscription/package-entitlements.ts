import { EntitlementSource, Prisma } from '@prisma/client';

/**
 * How a package's `includedFeatureKeys` become `package_included`
 * entitlements (F-018-e, F-018-o). One module, so a subscription `PUT`, a
 * package edit, a forced apply and the renewal (F-019-c) cannot drift apart.
 *
 * **Lock order, always package before subscriptions** — every caller takes the
 * package row first ({@link lockPackage}), then the subscription or tenant
 * rows. A package edit and a subscription change on the same package then
 * serialise instead of interleaving, and never deadlock. Entitlements from any
 * other source are never touched here.
 */

type Tx = Prisma.TransactionClient;

/** `FOR UPDATE` when the package is about to change, `FOR SHARE` when only its keys are read. */
export async function lockPackage(tx: Tx, packageId: string, mode: 'update' | 'share'): Promise<void> {
  if (mode === 'update') {
    await tx.$queryRaw`SELECT id FROM "tenant"."tenant_feature_package" WHERE id = ${packageId}::uuid FOR UPDATE`;
  } else {
    await tx.$queryRaw`SELECT id FROM "tenant"."tenant_feature_package" WHERE id = ${packageId}::uuid FOR SHARE`;
  }
}

/**
 * The package's current subscribers, their subscription rows locked. A
 * subscription moving to another package commits first, and Postgres
 * re-checks `packageId` before returning it, so a tenant that just left is
 * not granted this package's keys.
 */
export async function lockSubscribers(tx: Tx, packageId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ tenantId: string }[]>`
    SELECT "tenantId" FROM "tenant"."tenant_subscription" WHERE "packageId" = ${packageId}::uuid FOR UPDATE`;
  return rows.map((r) => r.tenantId);
}

/** The tenants' `package_included` entitlements become exactly `keys` — removals included. */
export async function replacePackageEntitlements(tx: Tx, tenantIds: string[], keys: string[]): Promise<void> {
  if (tenantIds.length === 0) return;
  await tx.tenantFeatureEntitlement.deleteMany({ where: { tenantId: { in: tenantIds }, source: EntitlementSource.package_included } });
  await insert(tx, tenantIds.flatMap((tenantId) => keys.map((featureKey) => ({ tenantId, featureKey }))));
}

/** Grants `keys` to the tenants that do not hold them from the package yet; nothing is removed. */
export async function addPackageEntitlements(tx: Tx, tenantIds: string[], keys: string[]): Promise<void> {
  if (tenantIds.length === 0 || keys.length === 0) return;
  const held = await tx.tenantFeatureEntitlement.findMany({
    where: { tenantId: { in: tenantIds }, featureKey: { in: keys }, source: EntitlementSource.package_included },
    select: { tenantId: true, featureKey: true },
  });
  const has = new Set(held.map((h) => `${h.tenantId}:${h.featureKey}`));
  await insert(
    tx,
    tenantIds.flatMap((tenantId) => keys.filter((featureKey) => !has.has(`${tenantId}:${featureKey}`)).map((featureKey) => ({ tenantId, featureKey }))),
  );
}

async function insert(tx: Tx, pairs: { tenantId: string; featureKey: string }[]): Promise<void> {
  if (pairs.length === 0) return;
  await tx.tenantFeatureEntitlement.createMany({
    data: pairs.map(
      ({ tenantId, featureKey }): Prisma.TenantFeatureEntitlementCreateManyInput => ({
        tenantId,
        featureKey,
        isEnabled: true,
        source: EntitlementSource.package_included,
        expiresAt: null,
      }),
    ),
  });
}
