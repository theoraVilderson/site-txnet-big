/**
 * A throwaway Postgres carrying **the database this repo actually ships**.
 *
 * The isolation harness (`tenant-context/isolation-harness.int.spec.ts`) needs
 * something no other tier in this workspace has: a database built from the
 * committed migration history, with the two login roles Row-Level Security
 * needs. The e2e tier cannot be it — `prisma db push` builds a schema from
 * `schema.prisma` and skips the history, so it has no policies, no
 * `current_tenant_id()` and no roles at all.
 *
 * Both inputs are read off disk rather than restated here, and that is the
 * point rather than a convenience:
 *
 *   * `prisma/domains/migrations/*​/migration.sql`, applied in order — so what
 *     is measured is the history, including a migration written next month.
 *   * the SQL inside `scripts/db-login-roles.sh` — so a hand edit granting one
 *     of those roles `BYPASSRLS` turns the harness red instead of turning the
 *     policies into decoration. A copy of that SQL here would be edited by the
 *     same person, on a different day, and would agree with itself.
 *
 * Two environment knobs, both with working defaults:
 *   TEST_POSTGRES_IMAGE  image to run (default: the mirror this repo already
 *                        pulls its dev Postgres from — Docker Hub is not
 *                        reachable here).
 *   TESTCONTAINERS_RYUK_DISABLED  forced on, for the reason `redis-fixture.ts`
 *                        gives: the reaper sidecar lives on Docker Hub.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';

const IMAGE =
  process.env.TEST_POSTGRES_IMAGE ?? 'docker.arvancloud.ir/postgres:18-alpine';

const REPO = join(__dirname, '../../../..');
const DOMAINS = join(REPO, 'txnet-backend/prisma/domains');
const MIGRATIONS = join(DOMAINS, 'migrations');
const ROLE_SCRIPT = join(REPO, 'scripts/db-login-roles.sh');

const DB = 'txnet';
const OWNER = 'postgres';
const OWNER_PASSWORD = 'harness_owner';
/**
 * The two passwords the role script takes from the environment. Fixed and
 * unremarkable on purpose: they are the credentials of a container that is
 * destroyed at the end of the file, and a generated one would only make the
 * connection strings harder to read in a failure.
 */
const APP_PASSWORD = 'harness_app';
const CROSS_TENANT_PASSWORD = 'harness_cross_tenant';

export interface PostgresFixture {
  /** `txnet_app_user` — what `DATABASE_APP_URL` names in a real deployment. */
  readonly appUrl: string;
  /** `txnet_cross_tenant_user` — `DATABASE_CROSS_TENANT_URL`. */
  readonly crossTenantUrl: string;
  /** The role `prisma migrate` runs as: the seeder, and the negative control. */
  readonly ownerUrl: string;
  stop(): Promise<void>;
}

export async function startPostgresFixture(): Promise<PostgresFixture> {
  const container: StartedTestContainer = await new GenericContainer(IMAGE)
    .withEnvironment({
      POSTGRES_USER: OWNER,
      POSTGRES_PASSWORD: OWNER_PASSWORD,
      POSTGRES_DB: DB,
    })
    .withExposedPorts(5432)
    .withCopyDirectoriesToContainer([
      { source: MIGRATIONS, target: '/migrations' },
    ])
    .withCopyContentToContainer([
      { content: loginRoleSql(), target: '/login-roles.sql' },
    ])
    // The entrypoint starts the server, runs the init scripts and restarts it,
    // so the ready line appears twice and the first one is a server that is
    // about to go away.
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .withStartupTimeout(120_000)
    .start();

  const psql = async (args: string[], what: string) => {
    const result = await container.exec([
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      OWNER,
      '-d',
      DB,
      '--quiet',
      ...args,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`${what} failed (exit ${result.exitCode}):\n${result.output}`);
    }
  };

  // In order, the way `prisma migrate deploy` applies them. Directory names are
  // timestamps, so lexical order is chronological order — the same assumption
  // Prisma itself makes.
  for (const name of migrationDirectories()) {
    await psql(['-f', `/migrations/${name}/migration.sql`], `migration ${name}`);
  }
  await psql(
    [
      '-v',
      `app_pw=${APP_PASSWORD}`,
      '-v',
      `xt_pw=${CROSS_TENANT_PASSWORD}`,
      '-f',
      '/login-roles.sql',
    ],
    'scripts/db-login-roles.sh',
  );

  const url = (user: string, password: string) =>
    `postgresql://${user}:${password}@${container.getHost()}:${container.getMappedPort(
      5432,
    )}/${DB}?schema=public`;

  return {
    appUrl: url('txnet_app_user', APP_PASSWORD),
    crossTenantUrl: url('txnet_cross_tenant_user', CROSS_TENANT_PASSWORD),
    ownerUrl: url(OWNER, OWNER_PASSWORD),
    stop: () => container.stop().then(() => undefined),
  };
}

/** Every migration directory that has a `migration.sql`, chronologically. */
function migrationDirectories(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        readFileSync(join(MIGRATIONS, name, 'migration.sql'));
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * The `psql` heredoc out of `scripts/db-login-roles.sh`.
 *
 * The script is bash around one SQL document: it reads `.env`, checks for the
 * two passwords and pipes the rest into `psql` inside the dev container. None
 * of that applies here, but the SQL does — it is where `NOBYPASSRLS` and the
 * two `REVOKE`s that keep the roles apart are asserted, and the harness is only
 * worth having if it measures the statements an operator actually runs.
 *
 * It is extracted rather than executed because running the script would need
 * this repo's `.env`, a container named `txnet-dev-postgres` and a willingness
 * to write to it — three things a test must not have.
 */
function loginRoleSql(): string {
  const script = readFileSync(ROLE_SCRIPT, 'utf8');
  const body = /<<'SQL'\n([\s\S]*?)\nSQL\n/.exec(script)?.[1];
  if (!body) {
    // Not a skip: a role script this cannot read is a role script nobody is
    // measuring, and silence there is exactly the failure this file exists to
    // make impossible.
    throw new Error(
      `Could not find the psql heredoc in ${ROLE_SCRIPT}. The isolation harness ` +
        `reads its SQL from that script on purpose — if the script's shape changed, ` +
        `update this extractor rather than pasting the SQL here.`,
    );
  }
  return body;
}

/**
 * `schema.table` for every model in `prisma/domains/*.prisma` carrying a
 * `tenantId` — the list of tables that must be policied.
 *
 * The same parse `tenant-context/rls-coverage.spec.ts` runs against the
 * migration *text*; the harness runs it against a live catalog. Both read the
 * schema rather than a hand-written list, because a hand-written list has to be
 * edited by the same person who forgot the policy.
 */
export function tenantScopedTables(): string[] {
  const tables: string[] = [];
  for (const file of readdirSync(DOMAINS).filter((f) => f.endsWith('.prisma'))) {
    const src = readFileSync(join(DOMAINS, file), 'utf8');
    for (const model of src.matchAll(/^model\s+\w+\s*\{([\s\S]*?)^\}/gm)) {
      const body = model[1];
      if (!/^\s*tenantId\s/m.test(body)) continue;
      const table = /@@map\("([^"]+)"\)/.exec(body)?.[1];
      const schema = /@@schema\("([^"]+)"\)/.exec(body)?.[1];
      if (table && schema) tables.push(`${schema}.${table}`);
    }
  }
  return tables.sort();
}

/**
 * Container start plus nine migrations dominates this file; the assertions are
 * milliseconds.
 */
export const HARNESS_TIMEOUT_MS = 240_000;
