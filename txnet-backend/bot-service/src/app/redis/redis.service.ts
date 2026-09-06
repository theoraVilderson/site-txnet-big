import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * The same keyspace `auth-service` writes, under the same prefix: one
 * `REDIS_KEYSPACE_VERSION` bump must abandon every key this platform holds,
 * bot sessions included (ADR-0005). Keys themselves are built in
 * `redis.keys.ts` and nowhere else (C-03).
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  public readonly client: Redis;
  public readonly keyPrefix: string;

  constructor(config: ConfigService) {
    const namespace = config.get<string>('REDIS_KEY_NAMESPACE', 'txnet:auth');
    const version = config.get<string>('REDIS_KEYSPACE_VERSION', 'v1');
    this.keyPrefix = `${namespace}:${version}:`;

    this.client = new Redis(config.get<string>('REDIS_URL')!, {
      keyPrefix: this.keyPrefix,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    this.client.on('error', (err) =>
      this.logger.error(`redis client error: ${err.message}`),
    );
  }

  async onModuleInit() {
    await this.client.connect();
    this.logger.log(`connected to redis (keyspace "${this.keyPrefix}")`);
  }

  onModuleDestroy() {
    this.client.disconnect();
  }

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSec?: number): Promise<void> {
    if (ttlSec === undefined) await this.client.set(key, value);
    else await this.client.set(key, value, 'EX', ttlSec);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A value we cannot parse is a value we cannot trust: drop it rather
      // than crash a conversation on every message from here on.
      this.logger.warn(`unparseable JSON at ${key} — dropping it`);
      await this.del(key);
      return null;
    }
  }

  setJson(key: string, value: unknown, ttlSec?: number): Promise<void> {
    return this.set(key, JSON.stringify(value), ttlSec);
  }

  /** Slides a key's expiry forward — how an idle TTL is kept alive. */
  async touch(key: string, ttlSec: number): Promise<void> {
    await this.client.expire(key, ttlSec);
  }
}
