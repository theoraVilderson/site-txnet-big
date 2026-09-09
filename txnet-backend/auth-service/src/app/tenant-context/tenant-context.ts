import { AsyncLocalStorage } from 'node:async_hooks';
import { ResolvedTenant } from '../tenant/tenant';

/**
 * The tenant a unit of work belongs to, carried rather than passed (ADR-0024).
 *
 * `tenant` decides *which* tenant a request is; this file only carries that
 * answer, so that a query does not depend on whoever wrote the call site
 * remembering to thread it through. The type is `tenant`'s and is re-exported
 * here, never redefined — one shape, one owner (§8).
 */
export { ResolvedTenant };

/**
 * Thrown when something that must be tenant-scoped runs with no scope open.
 *
 * A named class rather than a plain `Error` because F-066-b's `withTenant`
 * extension has to distinguish "no tenant" from any other query failure: the
 * first is a bug in the caller's context, the second is the database.
 */
export class TenantContextMissing extends Error {
  constructor(what = 'this operation') {
    super(
      `No tenant is in scope for ${what}. A tenant-scoped read or write must ` +
        `run inside runWithTenant(), or explicitly inside runAcrossTenants().`,
    );
    this.name = 'TenantContextMissing';
  }
}

/**
 * Thrown when a query names a tenant other than the one in scope, or asks for
 * an operation `withTenant` cannot scope.
 *
 * Distinct from `TenantContextMissing` because the fix is different: that one
 * means nobody opened a scope, this one means the code and the scope disagree.
 * Overwriting the caller's value instead would turn an explicit cross-tenant
 * question into a quiet same-tenant answer — a wrong result rather than a
 * refused one, which is the outcome ADR-0024 exists to remove.
 */
export class TenantScopeConflict extends Error {
  constructor(what: string, inScope: string, requested?: string) {
    super(
      requested
        ? `${what} names tenant ${requested} while ${inScope} is in scope. ` +
            `Cross-tenant work goes through runAcrossTenants().`
        : `${what} cannot be scoped to tenant ${inScope}.`,
    );
    this.name = 'TenantScopeConflict';
  }
}

/**
 * What one unit of work knows about its tenant.
 *
 * `acrossTenants` is a scope of its own rather than the absence of a tenant.
 * "No scope was ever opened" (a detached timer, a queue consumer written later)
 * and "this code deliberately reads every tenant" must not be the same state:
 * the first is a bug that has to throw, the second is a decision that has to be
 * greppable.
 */
type TenantScope = {
  tenant: ResolvedTenant | null;
  acrossTenants: boolean;
};

const storage = new AsyncLocalStorage<TenantScope>();

export const TenantContext = {
  /**
   * The tenant in scope. Throws when there is none — including inside
   * `runAcrossTenants`, where asking for *the* tenant is a category error.
   */
  current(what?: string): ResolvedTenant {
    const tenant = storage.getStore()?.tenant ?? null;
    if (!tenant) throw new TenantContextMissing(what);
    return tenant;
  },

  /**
   * The tenant in scope, or `null`. For code that has a legitimate answer for
   * an unresolved tenant — `register` refuses with a translated message rather
   * than throwing an internal error at the user.
   */
  currentOrNull(): ResolvedTenant | null {
    return storage.getStore()?.tenant ?? null;
  },

  /**
   * Whether the current work is the audited cross-tenant escape. Read by
   * F-066-b's extension to decide between injecting a `tenantId` and leaving a
   * query alone; `runAcrossTenants` would do nothing observable without it.
   *
   * @deprecated since 2026-09-09 (F-066-m-b), with {@link runAcrossTenants}
   * and on the same schedule — it exists only to make that flag observable.
   */
  isAcrossTenants(): boolean {
    return storage.getStore()?.acrossTenants ?? false;
  },
};

/**
 * Run `fn` with `tenant` in scope. Entered once per request, at the edge
 * (`TenantContextMiddleware`) — never by a handler, which would resolve the
 * tenant a second way the first time someone forgot to.
 *
 * `null` is accepted and is not the same as opening no scope at all: the
 * request *was* resolved and the answer was "no tenant" (ADR-0025). Scoped
 * queries throw either way; the difference is only that this one is diagnosed.
 */
export function runWithTenant<T>(
  tenant: ResolvedTenant | null,
  fn: () => T,
): T {
  return storage.run({ tenant, acrossTenants: false }, fn);
}

/**
 * The one escape from tenant scoping (ADR-0024 decision 3).
 *
 * @deprecated since 2026-09-09 (F-066-m-b). Remove after F-066-n. Inject
 * `CrossTenantPrismaService` instead — it is the same escape, made of a
 * database role rather than a flag, and it has no callers to convert: the four
 * this had (`TenantResolverService`, `CredentialVaultService`,
 * `PrismaBotIntegrationDirectory`, the e2e harness) already hold it.
 *
 * **It does not work any more, and that is why it is going.** It binds no
 * `app.tenant_id`, so on any table carrying an RLS policy — which since
 * F-066-m-b is every table with a `tenantId` column — the application pool is
 * shown *no* rows rather than every tenant's. It fails in the safe direction
 * and it reads, at a call site, exactly like the working escape it used to be.
 * A callback cannot be the audit trail for something a connection string
 * decides.
 *
 * It stays for one release rather than being deleted alongside its replacement
 * (§8): nothing in this repo calls it, and a symbol removed in the same change
 * that replaces it gives an out-of-tree caller a compile error with no reading
 * to do.
 *
 * **`await` inside the callback, not outside it.** A Prisma promise is lazy: it
 * runs when it is awaited, so `runAcrossTenants(() => prisma.user.findMany())`
 * returns a promise that executes after the scope has already closed, and
 * throws `TenantContextMissing`. `async () => await ...` is the shape that
 * works. The same is true of `runWithTenant`, which is why the scope is opened
 * by a middleware that wraps `next()` rather than by a caller.
 */
export function runAcrossTenants<T>(fn: () => T): T {
  return storage.run({ tenant: null, acrossTenants: true }, fn);
}
