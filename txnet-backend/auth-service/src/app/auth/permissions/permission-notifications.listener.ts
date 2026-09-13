import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { permissionFingerprint } from './permission-fingerprint';
import { PermissionStateStore } from './permission-state.store';

/** The channel `20260913000000_identity_permissions_notify` writes to. */
export const PERMISSIONS_CHANNEL = 'identity_permissions_changed';

/** The part of a `pg.Client` this needs — so a spec can stand in for Postgres. */
export interface NotificationClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  on(event: 'notification', listener: (message: { payload?: string }) => void): unknown;
  on(event: 'error' | 'end', listener: (error?: Error) => void): unknown;
  end(): Promise<void>;
}

/** Builds a fresh, unconnected client. A new one per attempt: a `pg.Client` cannot reconnect. */
export const PERMISSIONS_LISTEN_CLIENT = Symbol('PERMISSIONS_LISTEN_CLIENT');
export type NotificationClientFactory = () => NotificationClient;

const MAX_BACKOFF_MS = 30_000;

/** Exactly the relation `TokenService` mints `permHash` from, so the two cannot disagree. */
const ROLE_PERMISSIONS = {
  id: true,
  rolePermissions: { select: { permission: { select: { key: true } } } },
} as const;

type RoleRow = { id: string; rolePermissions: { permission: { key: string } }[] };

/**
 * Keeps Redis's view of what each role grants, and which role each user holds,
 * in step with Postgres (F-101-b, ADR-0043 §4).
 *
 * Postgres notifies on `identity_permissions_changed` from a trigger, because
 * nothing in the application writes these rows — they change by SQL and by
 * migration. This process holds one `LISTEN` connection and rewrites the key a
 * notification names; every replica does the same, and every write is
 * idempotent.
 *
 * **It never fails the boot.** A Postgres that is not there yet is retried with
 * a backoff. What is lost while disconnected is recovered by recomputing every
 * role on each connect — notifications are not queued for a listener that was
 * away. Until the first connect succeeds the keys are simply absent, and an
 * absent key refuses nobody.
 */
@Injectable()
export class PermissionNotificationsListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PermissionNotificationsListener.name);
  private client: NotificationClient | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1_000;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PermissionStateStore,
    @Inject(PERMISSIONS_LISTEN_CLIENT)
    private readonly newClient: NotificationClientFactory,
  ) {}

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
      this.logger.warn(`permission listener connection failed: ${error?.message ?? 'unknown'}`);
    });
    client.on('end', () => this.reconnectLater(client));

    try {
      await client.connect();
      // LISTEN first: a change committed between the two steps is then caught
      // by the notification or by the recompute, never by neither.
      await client.query(`LISTEN ${PERMISSIONS_CHANNEL}`);
      this.backoffMs = 1_000;
      await this.recomputeAll();
      this.logger.log('listening for permission changes');
    } catch (error) {
      this.logger.warn(
        `permission listener could not start, retrying in ${this.backoffMs}ms: ${(error as Error).message}`,
      );
      await client.end().catch((): void => undefined);
      this.reconnectLater(client);
    }
  }

  /** What one notification means. An unreadable one is logged and dropped, never thrown. */
  async handle(payload: string | undefined): Promise<void> {
    let event: { kind?: unknown; roleId?: unknown; userId?: unknown };
    try {
      event = JSON.parse(payload ?? '');
    } catch {
      this.logger.warn('ignored a permission notification that is not JSON');
      return;
    }
    try {
      if (event.kind === 'role' && typeof event.roleId === 'string') {
        await this.recomputeRole(event.roleId);
      } else if (
        event.kind === 'user' &&
        typeof event.userId === 'string' &&
        typeof event.roleId === 'string'
      ) {
        await this.store.writeUserRole(event.userId, event.roleId);
      } else if (event.kind === 'all') {
        await this.recomputeAll();
      } else {
        this.logger.warn('ignored a permission notification of an unknown shape');
      }
    } catch (error) {
      // A failed write leaves the old key, which is the state before this
      // notification — not a wrong one. The next connect recomputes it.
      this.logger.error(`permission notification not applied: ${(error as Error).message}`);
    }
  }

  async recomputeAll(): Promise<void> {
    const roles = await this.prisma.role.findMany({ select: ROLE_PERMISSIONS });
    for (const role of roles) await this.store.writeRole(role.id, fingerprintOf(role));
  }

  private async recomputeRole(roleId: string): Promise<void> {
    const role = await this.prisma.role.findUnique({ where: { id: roleId }, select: ROLE_PERMISSIONS });
    // A role deleted in the same transaction has no users left to hold a token.
    if (role) await this.store.writeRole(role.id, fingerprintOf(role));
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

function fingerprintOf(role: RoleRow): string {
  return permissionFingerprint(role.rolePermissions.map((rp) => rp.permission.key));
}
