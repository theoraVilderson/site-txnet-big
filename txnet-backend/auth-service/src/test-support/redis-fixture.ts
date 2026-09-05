/**
 * A throwaway Redis for one integration spec file.
 *
 * These stores are almost entirely Redis semantics — Lua atomicity, KEEPTTL,
 * MULTI/EXEC, TTL stickiness. A mock that re-implements those semantics only
 * proves the mock agrees with itself, so every store spec runs against a real
 * server in a container of its own.
 *
 * Two environment knobs, both with working defaults:
 *   TEST_REDIS_IMAGE  image to run (default: the mirror this repo already pulls
 *                     its dev Redis from — Docker Hub is not reachable here).
 *   TESTCONTAINERS_RYUK_DISABLED  forced on: the reaper sidecar lives on Docker
 *                     Hub, and every container started here is stopped in
 *                     `afterAll` anyway.
 */
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { RedisService } from '../app/redis/redis.service';

process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';

const IMAGE = process.env.TEST_REDIS_IMAGE ?? 'docker.arvancloud.ir/redis:8.8-alpine';

export interface RedisFixture {
  /** The service under test's dependency, wired to the container. */
  readonly redis: RedisService;
  /** `${namespace}:${version}:` — what ioredis prepends to every key. */
  readonly keyPrefix: string;
  /** A second, prefix-less client, for asserting the on-the-wire key names. */
  readonly raw: Redis;
  /** Wipe the database between tests. */
  flush(): Promise<void>;
  stop(): Promise<void>;
}

export async function startRedisFixture(options: {
  namespace?: string;
  version?: string;
} = {}): Promise<RedisFixture> {
  const container: StartedTestContainer = await new GenericContainer(IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .withStartupTimeout(120_000)
    .start();

  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  const namespace = options.namespace ?? 'txnet:auth';
  const version = options.version ?? 'v1';

  const redis = buildRedisService({
    REDIS_URL: url,
    REDIS_KEY_NAMESPACE: namespace,
    REDIS_KEYSPACE_VERSION: version,
  });
  // Same server, no prefix: lets a test read the literal key the service
  // wrote, which is the only way to catch a prefix regression from the inside.
  const raw = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });

  await redis.onModuleInit();
  await raw.connect();

  return {
    redis,
    raw,
    keyPrefix: redis.keyPrefix,
    flush: async () => {
      await raw.flushdb();
    },
    stop: async () => {
      await redis.onModuleDestroy();
      raw.disconnect();
      await container.stop();
    },
  };
}

function buildRedisService(env: Record<string, string>): RedisService {
  const config = {
    get: <T>(key: string, fallback?: T) =>
      (env[key] as unknown as T) ?? fallback,
  } as unknown as ConfigService;
  return new RedisService(config);
}

/**
 * Container start dominates every one of these files; the assertions
 * themselves are milliseconds.
 */
export const INTEGRATION_TIMEOUT_MS = 180_000;
