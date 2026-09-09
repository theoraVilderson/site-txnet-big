/**
 * The isolation harness (catalog 20.2 **layer 3** / F-1204, F-066-n).
 *
 * Layers 1 and 2 are built: `withTenant` scopes every query on a registered
 * model (F-066-b), and Row-Level Security holds the same line in Postgres on
 * all 25 tables that carry a `tenantId` (F-066-m-a, F-066-m-b). Layer 3 is the
 * one the catalog describes as *"the layer that still works after code is
 * written by someone who never read this document"*, and until this file it did
 * not exist here: `docs/domains/tenant/invariants.md` row 13 says in as many
 * words that its behaviour was **proved by hand** against Postgres 18 on the
 * day it shipped, and that turning that proof into something that runs is this
 * row. This is that.
 *
 * Why it could not live in a tier that already existed:
 *
 *   * the unit tier has no database, so it can asserts the *text* of the
 *     migrations (`rls-coverage.spec.ts`) and nothing about their effect;
 *   * the e2e tier builds its schema with `prisma db push`, which skips the
 *     migration history entirely — so it runs against a database with no
 *     policies, no `current_tenant_id()` and no roles. A policy test there
 *     would pass by describing a database nobody ships.
 *
 * So the harness starts a Postgres of its own and applies **the committed
 * history** and **the committed role script**, both read off disk. That is the
 * measurement that matters: not "does this code do what I think", but "does
 * the thing we actually deploy isolate tenants". Every input is a file another
 * session can edit, and editing one of them wrongly is what turns this red.
 *
 * The behavioural half runs through the **production path** — the real
 * `PrismaService`, the real `withTenant` extension, the real `runWithTenant`
 * — rather than through hand-written SQL that re-states the policy. A probe
 * that issues its own `SET LOCAL` would prove Postgres works. What is in doubt
 * is whether *this application* binds the tenant the policy reads, and the only
 * way to measure that is to make the application do it.
 *
 * Finally, and this is the part that keeps the file honest: it contains a
 * **negative control**. A harness that only ever sees isolation cannot
 * distinguish a system that isolates from a probe that is broken. The owner
 * connection is the same probe against a connection RLS does not bind, and it
 * is asserted to see *both* tenants — which is simultaneously the proof that
 * the measurement works and the reason `PrismaService` refuses to fall back to
 * `DATABASE_URL`.
 *
 *   npm run test:int
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ResolvedTenant, TenantScopeConflict, runWithTenant } from './tenant-context';
import { withTenant } from './with-tenant';
import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  startPostgresFixture,
  tenantScopedTables,
} from '../../test-support/postgres-fixture';

jest.setTimeout(HARNESS_TIMEOUT_MS);

/** Two tenants and a user in each — the smallest world in which "leak" means anything. */
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ROLE_ID = '33333333-3333-4333-8333-333333333333';

const asTenant = (id: string, slug: string): ResolvedTenant => ({
  id,
  slug,
  via: 'domain',
});

let pg: PostgresFixture;

/** The application, exactly as `prisma.module.ts` builds it. */
let app: PrismaService;
/** The same role, unextended — for probes that must issue their own statement. */
let appRaw: PrismaService;
/** The audited escape (`CrossTenantPrismaService`'s role). */
let crossTenant: PrismaService;
/** The negative control: the migration role, which RLS does not bind. */
let owner: PrismaClient;

beforeAll(async () => {
  pg = await startPostgresFixture();

  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
  // A pool of one, so "the next query on the same connection" is a statement
  // about something rather than a coincidence — see the transaction-lifetime
  // probe below.
  appRaw = new PrismaService(`${pg.appUrl}&connection_limit=1`);
  crossTenant = new PrismaService(pg.crossTenantUrl);
  owner = new PrismaClient({ datasourceUrl: pg.ownerUrl });

  await seed();
});

afterAll(async () => {
  await Promise.allSettled([
    app?.$disconnect(),
    appRaw?.$disconnect(),
    crossTenant?.$disconnect(),
    owner?.$disconnect(),
  ]);
  await pg?.stop();
});

/**
 * Seeded through the owner, which is the one connection that may write to two
 * tenants at once — and the reason it may is the subject of the last block in
 * this file.
 */
async function seed() {
  await owner.$executeRawUnsafe(`
    INSERT INTO identity.role (id, name, "isSystemRole")
    VALUES ('${ROLE_ID}', 'harness_user', false)
    ON CONFLICT DO NOTHING
  `);
  for (const [id, slug] of [[TENANT_A, 'alpha'], [TENANT_B, 'beta']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', 'reseller', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
      ON CONFLICT DO NOTHING
    `);
    await owner.$executeRawUnsafe(`
      INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt")
      VALUES (gen_random_uuid(), '${id}', '${slug} person', 'x', '${ROLE_ID}', now())
    `);
  }
}

// ---------------------------------------------------------------------------
// 1. The database the committed history actually produces
// ---------------------------------------------------------------------------
//
// `rls-coverage.spec.ts` asks the same question of the migration *text*. This
// asks it of a live catalog, which is the only place the answer is a fact:
// a policy that fails to apply, a table created by a later migration after the
// `ALTER DEFAULT PRIVILEGES` loop, or a `FORCE` that was written but not run
// all look identical in a `.sql` file and different in `pg_class`.
describe('the committed migration history produces an isolating database', () => {
  it('finds tenant-scoped tables to check at all', async () => {
    // A guard on the guard, the same one `rls-coverage.spec.ts` carries: every
    // `it.each` below is vacuously green over an empty list.
    expect(tenantScopedTables().length).toBeGreaterThan(20);
  });

  it('has RLS enabled and forced on every table with a tenantId', async () => {
    const rows = await owner.$queryRawUnsafe<
      { table: string; enabled: boolean; forced: boolean }[]
    >(`
      SELECT n.nspname || '.' || c.relname AS "table",
             c.relrowsecurity  AS enabled,
             c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
    `);
    const state = new Map(rows.map((r) => [r.table, r]));

    for (const table of tenantScopedTables()) {
      // FORCE is not decoration: without it the table's owner — the role
      // `prisma migrate` runs as — is exempt from its own policies.
      expect(state.get(table)).toEqual(
        expect.objectContaining({ enabled: true, forced: true }),
      );
    }
  });

  it('gives every one of them both policies, and each to its own role', async () => {
    const rows = await owner.$queryRawUnsafe<
      { table: string; policy: string; roles: string[] }[]
    >(`
      SELECT schemaname || '.' || tablename AS "table",
             policyname AS policy,
             roles::text[] AS roles
      FROM pg_policies
    `);

    for (const table of tenantScopedTables()) {
      const forTable = rows.filter((r) => r.table === table);
      expect(forTable.find((r) => r.policy === 'tenant_isolation')?.roles).toEqual(
        ['txnet_app'],
      );
      expect(forTable.find((r) => r.policy === 'cross_tenant')?.roles).toEqual(
        ['txnet_cross_tenant'],
      );
    }
  });

  it('grants the escape by policy and never by BYPASSRLS', async () => {
    // The whole of F-1202's "bypassing RLS on the normal pool is not possible"
    // rests on this: there is no connection string in this system that turns
    // the rules off, only one that is granted different ones. A role that
    // acquired the attribute by hand later would leave every assertion above
    // green and every one below meaningless.
    const roles = await owner.$queryRawUnsafe<
      { rolname: string; rolbypassrls: boolean; rolsuper: boolean }[]
    >(`
      SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
      WHERE rolname LIKE 'txnet_%'
    `);
    expect(roles.length).toBe(4);
    for (const role of roles) {
      expect({ ...role, rolbypassrls: false, rolsuper: false }).toEqual(role);
    }
  });

  it('leaves the application role owning nothing', async () => {
    // Ownership is the other exemption, and the quieter one: an owner is
    // exempt from its own policies unless FORCE is set, so a role that came to
    // own a table would be isolated only by the previous test's `forced`.
    const owned = await owner.$queryRawUnsafe<{ count: bigint }[]>(`
      SELECT count(*) FROM pg_class c
      JOIN pg_roles r ON r.oid = c.relowner
      WHERE r.rolname = 'txnet_app_user'
    `);
    expect(Number(owned[0].count)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Row 13's five hand-proved properties, through the production path
// ---------------------------------------------------------------------------
describe('a tenant-scoped row is invisible to a connection that named no tenant', () => {
  it('shows an unbound connection no rows, rather than every row', async () => {
    // The direction of failure is the whole design. `current_setting(…, true)`
    // is NULL when nothing bound it and `"tenantId" = NULL` is never true, so
    // forgetting to scope is an empty result — never another tenant's data.
    const rows = await appRaw.$queryRawUnsafe<unknown[]>(
      'SELECT id FROM identity."user"',
    );
    expect(rows).toEqual([]);
  });

  it('shows a bound connection exactly one tenant', async () => {
    // `async () => await …`, not `() => …`. A Prisma promise is lazy, so the
    // second shape returns a description of a query that runs after the scope
    // has closed — `TenantContextMissing`, from code that reads correct. It is
    // documented on `runWithTenant`, this harness rediscovered it on its first
    // run, and it is why the scope is opened by a middleware wrapping `next()`
    // rather than by each caller.
    const a = await runWithTenant(asTenant(TENANT_A, 'alpha'), async () =>
      app.user.findMany({ select: { tenantId: true } }),
    );
    const b = await runWithTenant(asTenant(TENANT_B, 'beta'), async () =>
      app.user.findMany({ select: { tenantId: true } }),
    );

    expect(a.map((u) => u.tenantId)).toEqual([TENANT_A]);
    expect(b.map((u) => u.tenantId)).toEqual([TENANT_B]);
  });

  it('refuses a write that names another tenant', async () => {
    // Two refusals, one property. The extension refuses in the application
    // (`TenantScopeConflict`), and it matters that the database refuses too —
    // because the extension is only reached by code that goes through Prisma
    // models, and ADR-0024 accepts that raw SQL and nested writes do not.
    await expect(
      runWithTenant(asTenant(TENANT_A, 'alpha'), async () =>
        app.user.create({
          data: {
            tenantId: TENANT_B,
            fullName: 'smuggled',
            passwordHash: 'x',
            roleId: ROLE_ID,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(TenantScopeConflict);

    await expect(
      appRaw.$transaction([
        appRaw.$executeRawUnsafe(
          `SELECT set_config('app.tenant_id', '${TENANT_A}', true)`,
        ),
        appRaw.$executeRawUnsafe(`
          INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt")
          VALUES (gen_random_uuid(), '${TENANT_B}', 'smuggled', 'x', '${ROLE_ID}', now())
        `),
      ]),
    ).rejects.toThrow(/row-level security/i);
  });

  it('lets the binding die with its transaction', async () => {
    // `is_local => true` is what makes this true, and it is not a detail:
    // bound session-wide, the setting would outlive the request on a pooled
    // connection and hand the next tenant the previous one's scope. `appRaw`
    // holds a pool of exactly one, so the read below is guaranteed to be on
    // the same physical connection the bound query just used.
    const bound = await appRaw.$transaction([
      appRaw.$executeRawUnsafe(
        `SELECT set_config('app.tenant_id', '${TENANT_A}', true)`,
      ),
      appRaw.$queryRawUnsafe<unknown[]>('SELECT id FROM identity."user"'),
    ]);
    expect(bound[1]).toHaveLength(1);

    const after = await appRaw.$queryRawUnsafe<unknown[]>(
      'SELECT id FROM identity."user"',
    );
    expect(after).toEqual([]);
  });

  it('lets the application role neither disable RLS nor become the escape', async () => {
    // The two ways an application mistake could otherwise become a leak
    // without anyone writing a cross-tenant query at all.
    await expect(
      appRaw.$executeRawUnsafe(
        'ALTER TABLE identity."user" DISABLE ROW LEVEL SECURITY',
      ),
    ).rejects.toThrow(/must be owner|permission denied/i);

    await expect(
      appRaw.$executeRawUnsafe('SET ROLE txnet_cross_tenant'),
    ).rejects.toThrow(/permission denied|not a member/i);
  });
});

// ---------------------------------------------------------------------------
// 3. The escape, and the control that proves the probe can tell the difference
// ---------------------------------------------------------------------------
describe('the escape is a policy, and the measurement is real', () => {
  it('shows the cross-tenant role every tenant, with nothing bound', async () => {
    // `CrossTenantPrismaService` deliberately carries no `withTenant`: its
    // callers are the reads that *produce* a tenant and so cannot have one.
    const rows = await crossTenant.user.findMany({ select: { tenantId: true } });
    expect(new Set(rows.map((u) => u.tenantId))).toEqual(
      new Set([TENANT_A, TENANT_B]),
    );
  });

  it('negative control: the migration role sees both, which is why there is no fallback', async () => {
    // If this ever goes green *and* the unbound-app probe above sees rows too,
    // the harness has stopped measuring anything. It is here so that the file
    // cannot pass by failing to connect, failing to seed, or querying an empty
    // table — the three ways a security test quietly becomes decoration.
    //
    // It is also the statement of why `PrismaService` has no fallback from
    // `DATABASE_APP_URL` to `DATABASE_URL`: this is what that fallback would
    // reach, and it looks exactly like a working system.
    const rows = await owner.$queryRawUnsafe<{ tenantId: string }[]>(
      'SELECT "tenantId" FROM identity."user"',
    );
    expect(new Set(rows.map((u) => u.tenantId))).toEqual(
      new Set([TENANT_A, TENANT_B]),
    );
  });
});
