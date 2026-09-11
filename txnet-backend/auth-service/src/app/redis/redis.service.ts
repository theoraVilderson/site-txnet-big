import {
  REDIS_KEYSPACE_VERSION_DEFAULT,
  REDIS_KEY_NAMESPACE_DEFAULT,
  buildRedisKeyPrefix,
} from '@txnet-backend/shared-core';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

// Atomic fixed-window counter: INCR, and on the first hit of a window attach
// the TTL in the same round-trip, so a crash between the two commands can't
// leave a key without an expiry.
const INCR_WITH_TTL = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  public readonly client: Redis;

  /**
   * Namespace applied by ioredis to every key of every command (including the
   * KEYS of EVAL scripts and MULTI pipelines). Assembled from
   * `REDIS_KEY_NAMESPACE` + `REDIS_KEYSPACE_VERSION` so the same Redis can be
   * shared across services/environments without collisions, and bumping the
   * version env var abandons the whole keyspace in one move.
   */
  public readonly keyPrefix: string;

  constructor(private readonly config: ConfigService) {
    const namespace = this.config.get<string>(
      'REDIS_KEY_NAMESPACE',
      REDIS_KEY_NAMESPACE_DEFAULT,
    );
    const version = this.config.get<string>(
      'REDIS_KEYSPACE_VERSION',
      REDIS_KEYSPACE_VERSION_DEFAULT,
    );
    this.keyPrefix = buildRedisKeyPrefix(namespace, version);

    this.client = new Redis(this.config.get<string>('REDIS_URL')!, {
      keyPrefix: this.keyPrefix,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });

    // ioredis emits 'error' on every connection failure/retry; with no
    // listener, Node treats it as an uncaught exception and kills the whole
    // process instead of failing just the in-flight request.
    this.client.on('error', (err) => {
      this.logger.error(`redis client error: ${err.message}`);
    });
  }

  async onModuleInit() {
    await this.client.connect();
    this.logger.log(`connected to redis (keyspace "${this.keyPrefix}")`);
  }

  async onModuleDestroy() {
    this.client.disconnect();
  }

  // --- Generic helpers. Application code should go through these (or a Store)
  // instead of reaching into `client`; `client` stays public for the few
  // places that genuinely need pipelines or bespoke commands. ---

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  /**
   * Publish on a Redis pub/sub channel (F-067-j).
   *
   * `channel` is a **fully-built wire name**, prefix included, and that is not
   * an oversight: ioredis prepends `keyPrefix` to key arguments only, and
   * Redis does not count a pub/sub channel as a key. Taking the finished name
   * keeps the one place that difference matters at the call site, next to the
   * comment explaining it, rather than hidden in a method that silently does
   * the opposite of every other method here.
   */
  async publish(channel: string, body: string): Promise<void> {
    await this.client.publish(channel, body);
  }

  async set(key: string, value: string, ttlSec?: number): Promise<void> {
    if (ttlSec === undefined) {
      await this.client.set(key, value);
    } else {
      await this.client.set(key, value, 'EX', ttlSec);
    }
  }

  async setNx(key: string, value: string, ttlSec: number): Promise<boolean> {
    const result = await this.client.set(key, value, 'EX', ttlSec, 'NX');
    return result === 'OK';
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  setJson(key: string, value: unknown, ttlSec?: number): Promise<void> {
    return this.set(key, JSON.stringify(value), ttlSec);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.client.del(...keys);
  }

  /** INCR `key`, attaching `ttlSec` atomically on the first hit of the window. */
  incrementWithTtl(key: string, ttlSec: number): Promise<number> {
    return this.evalScript<number>(INCR_WITH_TTL, [key], [ttlSec]);
  }

  evalScript<T = unknown>(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<T> {
    return this.client.eval(script, keys.length, ...keys, ...args) as Promise<T>;
  }
}
