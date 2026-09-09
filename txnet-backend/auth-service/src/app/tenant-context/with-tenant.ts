import { Prisma } from '@prisma/client';
import { TenantContext, TenantScopeConflict } from './tenant-context';

/**
 * The tenant-scoped Prisma extension (ADR-0024 decision 2, catalog 20.2
 * layer 2 / F-1203).
 *
 * Every query on a registered model has `tenantId` injected into its `where`
 * and into what it creates, and throws when there is no ambient tenant. The
 * point is not that scoping becomes easier to write — it is that forgetting it
 * stops being possible, including in a call site written next month by someone
 * who never read ADR-0024.
 */

/**
 * The registry — the models this extension scopes, by Prisma delegate name.
 *
 * Explicit, and not "every model with a `tenantId` column" (ADR-0024): a model
 * gaining that column is a schema change, and how it is queried afterwards
 * should be a decision someone made rather than a side effect. `linkedBotAccount`
 * joined `user` with F-066-l — catalog 10.5 links a messenger account to a
 * person *within a tenant*, and a chat id is the one identifier here that the
 * messenger issues rather than we do, so it is identical across every
 * reseller's bots.
 */
export const TENANT_SCOPED_MODELS = ['user', 'linkedBotAccount'] as const;

export type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];

/**
 * Operations that create rows and take no `where`: the tenant goes into the
 * data, not into a filter.
 */
const CREATE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
]);

/**
 * Operations that take a `where`. `update` and `delete` are here rather than
 * with the creates because Prisma's `WhereUniqueInput` has accepted ordinary
 * filters alongside the unique field since v5 — so a `findUnique` on a
 * globally-unique column simply gains `tenantId` and stays a `findUnique`.
 * (ADR-0024 predicted this would have to become a `findFirst`; it does not.)
 * `update` and `upsert` also write, but their `data` is an update to a row the
 * `where` already proved belongs to the tenant.
 */
const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'aggregate',
  'count',
  'groupBy',
]);

/** `upsert` is the one operation that both filters and creates. */
const UPSERT = 'upsert';

type Args = Record<string, unknown>;

/**
 * Merge the tenant into a `where`, refusing a `where` that names a different
 * one. Silently overwriting it would turn a caller's explicit cross-tenant
 * question into a same-tenant answer, which is a wrong result rather than a
 * refused one — and refusing is this unit's whole contract (rule 3).
 */
function scopeWhere(where: unknown, tenantId: string, what: string): Args {
  const current = (where as Args | undefined)?.['tenantId'];
  if (typeof current === 'string' && current !== tenantId) {
    throw new TenantScopeConflict(what, tenantId, current);
  }
  return { ...((where as Args) ?? {}), tenantId };
}

/** The same rule for a row being written. */
function scopeData(data: unknown, tenantId: string, what: string): unknown {
  if (Array.isArray(data)) {
    return data.map((row) => scopeData(row, tenantId, what));
  }
  const current = (data as Args | undefined)?.['tenantId'];
  if (typeof current === 'string' && current !== tenantId) {
    throw new TenantScopeConflict(what, tenantId, current);
  }
  return { ...((data as Args) ?? {}), tenantId };
}

/**
 * Rewrite one operation's arguments so they carry the tenant.
 *
 * Exported for its own test: this is the whole rule, and it is worth asserting
 * without a database behind it.
 */
export function scopeArgs(
  operation: string,
  args: unknown,
  tenantId: string,
  what: string,
): unknown {
  const input = (args as Args) ?? {};

  if (operation === UPSERT) {
    return {
      ...input,
      where: scopeWhere(input['where'], tenantId, what),
      create: scopeData(input['create'], tenantId, what),
    };
  }

  if (CREATE_OPERATIONS.has(operation)) {
    return { ...input, data: scopeData(input['data'], tenantId, what) };
  }

  if (WHERE_OPERATIONS.has(operation)) {
    return { ...input, where: scopeWhere(input['where'], tenantId, what) };
  }

  // An operation this file has never heard of is not scoped, and running it
  // unscoped is exactly the outcome the extension exists to make impossible.
  // Refusing is loud, greppable and one line to fix; the alternative is a
  // cross-tenant read nobody notices (rule 3).
  throw new TenantScopeConflict(
    `${what} — \`${operation}\` is not a scopeable operation`,
    tenantId,
  );
}

/**
 * The extension itself. Applied once, to the client every service injects
 * (`prisma.module.ts`), so no call site opts in and none can opt out.
 *
 * `runAcrossTenants()` is the single exception: inside it the arguments are
 * passed through untouched. That is what makes the escape observable — without
 * `isAcrossTenants()` this extension could not tell "read every tenant,
 * deliberately" from "this code forgot" (ADR-0024 decision 3).
 */
/**
 * The `query` map the extension installs — one `$allOperations` hook per
 * registered model. Exported because `Prisma.defineExtension` returns an opaque
 * function, and this map, not that function, is the rule worth testing.
 */
export function tenantScopeQueryMap() {
  const scope = async ({
    model,
    operation,
    args,
    query,
  }: {
    model: string;
    operation: string;
    args: unknown;
    query: (args: unknown) => Promise<unknown>;
  }) => {
    if (TenantContext.isAcrossTenants()) return query(args);

    const what = `${model}.${operation}`;
    const tenant = TenantContext.current(what);
    return query(scopeArgs(operation, args, tenant.id, what));
  };

  // Built from the registry rather than written out per model, so adding a
  // model is one line in `TENANT_SCOPED_MODELS` and nothing else. Prisma types
  // the `query` map per model, and a map built from a list cannot be expressed
  // in those types — the handler above is what the cast below asserts.
  return Object.fromEntries(
    TENANT_SCOPED_MODELS.map((model) => [model, { $allOperations: scope }]),
  );
}

/**
 * The extension itself. Applied once, to the client every service injects
 * (`prisma.module.ts`), so no call site opts in and none can opt out.
 *
 * `runAcrossTenants()` is the single exception: inside it the arguments are
 * passed through untouched. That is what makes the escape observable — without
 * `isAcrossTenants()` this extension could not tell "read every tenant,
 * deliberately" from "this code forgot" (ADR-0024 decision 3).
 */
export function withTenant() {
  return Prisma.defineExtension({
    name: 'withTenant',
    query: tenantScopeQueryMap(),
  } as Parameters<typeof Prisma.defineExtension>[0]);
}
