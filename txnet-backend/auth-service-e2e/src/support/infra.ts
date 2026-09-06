/**
 * The two real backing services `auth-service` cannot be exercised without:
 * Postgres (the record) and Redis (sessions, OTP, rate limits, captcha).
 *
 * Both run in throwaway containers, started once for the whole e2e run in
 * `global-setup.ts` and stopped in `global-teardown.ts`. Jest workers are
 * forked after global setup, so the connection strings are handed to them
 * through a small JSON file rather than through `process.env` — one file,
 * one source of truth, and no dependence on how a runner propagates env.
 *
 * Images come from the same mirror the rest of the repo pulls from (Docker
 * Hub is not reachable from the dev environment); override with
 * TEST_POSTGRES_IMAGE / TEST_REDIS_IMAGE where it is.
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

const exec = promisify(execFile);

process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';

const POSTGRES_IMAGE =
  process.env.TEST_POSTGRES_IMAGE ?? 'docker.arvancloud.ir/postgres:18-alpine';
const REDIS_IMAGE =
  process.env.TEST_REDIS_IMAGE ?? 'docker.arvancloud.ir/redis:8.8-alpine';

/** The Nx workspace root — where `prisma/` and `package.json` live. */
export const WORKSPACE_ROOT = join(__dirname, '..', '..', '..');

/** Where the connection strings are parked for the test workers. */
export const INFRA_FILE = join(tmpdir(), 'txnet-auth-e2e-infra.json');

export interface InfraHandles {
  databaseUrl: string;
  redisUrl: string;
}

export async function startInfra(): Promise<{
  urls: InfraHandles;
  stop: () => Promise<void>;
}> {
  const [postgres, redis] = await Promise.all([
    new GenericContainer(POSTGRES_IMAGE)
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_USER: 'e2e',
        POSTGRES_PASSWORD: 'e2e',
        POSTGRES_DB: 'e2e',
      })
      // The entrypoint starts the server once to run initdb and again for
      // real, so the readiness line has to be seen twice.
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .withStartupTimeout(180_000)
      .start(),
    new GenericContainer(REDIS_IMAGE)
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(180_000)
      .start(),
  ]);

  const urls: InfraHandles = {
    databaseUrl: `postgresql://e2e:e2e@${postgres.getHost()}:${postgres.getMappedPort(
      5432,
    )}/e2e`,
    redisUrl: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
  };

  return {
    urls,
    stop: async () => {
      await Promise.all([postgres.stop(), redis.stop()]);
    },
  };
}

/**
 * Creates the 14 schemas and every table from `prisma/domains/*.prisma`, then
 * runs the repo's own seed — the `platform_owner` tenant and the four system
 * roles, which `RegisterService` looks up by name and nothing in the API ever
 * creates. Using the real seed script means a broken bootstrap fails here
 * instead of in production.
 */
export async function migrateAndSeed(databaseUrl: string): Promise<void> {
  const env = { ...process.env, DATABASE_URL: databaseUrl };
  await exec('npx', ['prisma', 'db', 'push', '--skip-generate'], {
    cwd: WORKSPACE_ROOT,
    env,
  });
  await exec('node', ['prisma/seed.js'], { cwd: WORKSPACE_ROOT, env });
}

export function writeInfraFile(urls: InfraHandles): void {
  writeFileSync(INFRA_FILE, JSON.stringify(urls), 'utf8');
}

export function readInfraFile(): InfraHandles {
  return JSON.parse(readFileSync(INFRA_FILE, 'utf8')) as InfraHandles;
}
