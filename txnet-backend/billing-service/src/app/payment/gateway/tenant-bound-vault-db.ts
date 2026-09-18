import {
  bindTenantThroughTransaction,
  TenantContext,
  type VaultDb,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { vaultTenantOverride } from './granted-vault-access';

/**
 * The connection `billing-service`'s vault queries through (ADR-0039).
 *
 * The app pool, with every query on the three vault tables bound to **the
 * tenant of the request** — not to the `tenantId` the vault was handed. So a
 * credential ref naming another tenant is not only filtered out by the vault's
 * own `where`; Row-Level Security shows it no row at all. `auth-service` needs
 * the cross-tenant pool because it resolves a tenant through the vault; this
 * service never does, the gate forwards one (F-092-a), so it gets no such pool.
 *
 * The vault models stay out of `TENANT_SCOPED_MODELS` (`tenant/contract.vault.md`):
 * this binds `app.tenant_id` and rewrites no arguments, so `auth-service` is
 * untouched.
 *
 * **One exception, and it is a proved one** (ADR-0041 §3, F-096-c): inside
 * `GrantedVaultAccess.along(...)` the bind target is the **gateway owner's**
 * tenant instead, because a granted gateway is charged with its owner's
 * merchant id. The override cannot be opened without a grant that has been read
 * back on this pool, in the borrower's own scope — so RLS is still what decides,
 * one call at a time. Everything else here is unchanged.
 *
 * **Reads only.** `$transaction` is refused: `put` rotates inside an
 * interactive transaction, where a per-query bind would run beside it rather
 * than in it (`with-tenant.ts`). Billing writes no credential — configuring
 * one is F-018, in `tenant-service` (F-018-ab).
 */
export function tenantBoundVaultDb(prisma: PrismaService): VaultDb {
  const bind = bindTenantThroughTransaction(prisma);
  const scoped = {
    $allOperations: ({
      model,
      operation,
      args,
      query,
    }: {
      model: string;
      operation: string;
      args: unknown;
      query: (args: unknown) => Promise<unknown>;
    }) =>
      bind(
        vaultTenantOverride()?.tenantId ?? TenantContext.current(`${model}.${operation}`).id,
        () => query(args),
      ),
  };
  const bound = prisma.$extends({
    query: {
      tenantCredential: scoped,
      tenantDek: scoped,
      tenantCredentialAccess: scoped,
    },
  } as Parameters<PrismaService['$extends']>[0]) as unknown as VaultDb;

  return {
    tenantCredential: bound.tenantCredential,
    tenantDek: bound.tenantDek,
    tenantCredentialAccess: bound.tenantCredentialAccess,
    $transaction: (() => {
      throw new Error(
        'billing-service reads tenant credentials and never writes them; ' +
          'store or rotate one through tenant-service (ADR-0039)',
      );
    }) as VaultDb['$transaction'],
  };
}
