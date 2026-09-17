import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

/** The part of a `pg.Client` a listener needs — so a spec can stand in for Postgres. */
export interface NotificationClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  on(event: 'notification', listener: (message: { payload?: string }) => void): unknown;
  on(event: 'error' | 'end', listener: (error?: Error) => void): unknown;
  end(): Promise<void>;
}

/** Builds a fresh, unconnected client. A new one per attempt: a `pg.Client` cannot reconnect. */
export type NotificationClientFactory = () => NotificationClient;

const MAX_BACKOFF_MS = 30_000;

/**
 * One `LISTEN` connection that keeps a Redis view in step with Postgres
 * (F-101-b's pattern, shared by F-018-f).
 *
 * **It never fails the boot.** A Postgres that is not there yet is retried with
 * a backoff. What is lost while disconnected is recovered by
 * {@link recomputeAll} on each connect — notifications are not queued for a
 * listener that was away. A subclass names its channel and says what one
 * payload and a full recompute mean; every write it makes must be idempotent,
 * because every replica does the same.
 */
export abstract class PgNotificationListener implements OnModuleInit, OnModuleDestroy {
  protected abstract readonly channel: string;
  protected abstract readonly logger: Logger;
  private client: NotificationClient | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private stopped = false;

  constructor(private readonly newClient: NotificationClientFactory) {}

  /** What one notification means. Must log and return, never throw. */
  abstract handle(payload: string | undefined): Promise<void>;

  /** Rewrite everything this listener owns. */
  abstract recomputeAll(): Promise<void>;

  onModuleInit(): void {
    void this.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    const client = this.client;
    this.client = null;
    await client?.end().catch((): void => undefined);
  }

  /** Connect, LISTEN, then recompute everything. Resolves whether or not it connected. */
  async start(): Promise<void> {
    if (this.stopped) return;
    const client = this.newClient();
    this.client = client;
    client.on('notification', (message): void => {
      void this.handle(message.payload);
    });
    client.on('error', (error) => {
      this.logger.warn(`${this.channel} listener connection failed: ${error?.message ?? 'unknown'}`);
    });
    client.on('end', () => this.reconnectLater(client));

    try {
      await client.connect();
      // LISTEN first: a change committed between the two steps is then caught
      // by the notification or by the recompute, never by neither.
      await client.query(`LISTEN ${this.channel}`);
      this.backoffMs = 1_000;
      await this.recomputeAll();
      this.logger.log(`listening on ${this.channel}`);
    } catch (error) {
      this.logger.warn(
        `${this.channel} listener could not start, retrying in ${this.backoffMs}ms: ${(error as Error).message}`,
      );
      await client.end().catch((): void => undefined);
      this.reconnectLater(client);
    }
  }

  private reconnectLater(client: NotificationClient): void {
    if (this.stopped || this.client !== client || this.retry) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.start();
    }, delay);
  }
}
