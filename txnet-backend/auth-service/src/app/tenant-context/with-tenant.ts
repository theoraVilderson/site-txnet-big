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
 * How a query tells Postgres which tenant it acts for (F-066-m-a, catalog 20.2
 * layer 1).
 *
 * The RLS policy on a scoped table reads `app.tenant_id`; the binder is what
 * sets it. Everything below turns on one property: **the setting and the query
 * are one transaction**. Postgres scopes a `set_config(..., is_local => true)`
 * to the transaction that ran it, and Prisma hands out a pooled connection per
 * statement — so a setting bound outside the query's transaction is bound on
 * some other connection, and the query then runs with no tenant at all. Under
 * RLS that is not an error: it is zero rows.
 */
export type TenantBinder = <T>(
  tenantId: string,
  query: () => T | Promise<T>,
) => Promise<T>;

/** The slice of `PrismaClient` {@link bindTenantThroughTransaction} needs. */
export interface TenantBindableClient {
  $executeRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): unknown;
  $transaction(operations: unknown[]): Promise<unknown[]>;
}

/**
 * The real binder: a two-statement batch transaction, `SET LOCAL` then the
 * query.
 *
 * `query()` is called but **not awaited** — a Prisma promise is lazy, so what
 * it returns is a description of a query rather than a running one, and handing
 * that description to `$transaction` is what puts both statements on one
 * connection. Awaiting it first would execute it immediately, on a connection
 * of its own, with no setting bound. (The same laziness `runAcrossTenants`
 * warns about, used deliberately this time.)
 *
 * **Known limit, and it fails closed.** A registered model queried inside an
 * interactive `prisma.$transaction(async (tx) => …)` cannot be bound this way:
 * the batch would nest. No call site does that today (§6.2b — the four
 * interactive transactions in this service touch `session`,
 * `linked_account_member`, `admin_audit_log` and the vault, none of them
 * registered), and the failure if one appears is a refused or empty query, not
 * a cross-tenant read.
 */
export function bindTenantThroughTransaction(
  client: TenantBindableClient,
): TenantBinder {
  return async <T>(tenantId: string, query: () => T | Promise<T>) => {
    const bind = client.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, ${true})`;
    const [, result] = await client.$transaction([bind, query()]);
    return result as T;
  };
}

/**
 * The `query` map the extension installs — one `$allOperations` hook per
 * registered model. Exported because `Prisma.defineExtension` returns an opaque
 * function, and this map, not that function, is the rule worth testing.
 */
export function tenantScopeQueryMap(bind: TenantBinder) {
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
    const scoped = scopeArgs(operation, args, tenant.id, what);
    return bind(tenant.id, () => query(scoped));
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
 * It takes the client it is about to extend, because since F-066-m-a the
 * extension has a second job: binding `app.tenant_id` for the RLS policy, which
 * needs a client to open the transaction on. `$extends` returns a *new* client
 * and leaves this one alone, so passing the base in is not a cycle.
 *
 * `runAcrossTenants()` is the single exception: inside it the arguments are
 * passed through untouched and nothing is bound. That is what makes the escape
 * observable — without `isAcrossTenants()` this extension could not tell "read
 * every tenant, deliberately" from "this code forgot" (ADR-0024 decision 3).
 * Under RLS the escape is served by a database role whose policy is
 * `USING (true)`; giving it its own pool, and retiring it, is F-066-m-b.
 */
export function withTenant(client: TenantBindableClient) {
  return Prisma.defineExtension({
    name: 'withTenant',
    query: tenantScopeQueryMap(bindTenantThroughTransaction(client)),
  } as Parameters<typeof Prisma.defineExtension>[0]);
}
