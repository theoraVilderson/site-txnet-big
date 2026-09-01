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
      'txnet:auth',
    );
    const version = this.config.get<string>('REDIS_KEYSPACE_VERSION', 'v1');
    this.keyPrefix = `${namespace}:${version}:`;

    this.client = new Redis(this.config.get<string>('REDIS_URL')!, {
      keyPrefix: this.keyPrefix,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
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
