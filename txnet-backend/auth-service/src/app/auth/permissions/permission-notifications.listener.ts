import { Inject, Injectable, Logger } from '@nestjs/common';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { NotificationClientFactory, PgNotificationListener } from '@txnet-backend/shared-core';
import { permissionFingerprint } from './permission-fingerprint';
import { PermissionStateStore } from './permission-state.store';

export type { NotificationClient, NotificationClientFactory } from '@txnet-backend/shared-core';

/** The channel `20260913000000_identity_permissions_notify` writes to. */
export const PERMISSIONS_CHANNEL = 'identity_permissions_changed';

export const PERMISSIONS_LISTEN_CLIENT = Symbol('PERMISSIONS_LISTEN_CLIENT');

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
 * **Why the cross-tenant pool.** Since F-018-n a role may belong to a tenant,
 * and `identity.role` is policied shared-read: on the app pool a connection
 * with no ambient tenant sees the system templates and nothing else. This
 * listener has no tenant by construction — a `LISTEN` callback is not a
 * request — and its job is every tenant's roles, so it reads through
 * `CrossTenantPrismaService`, whose `cross_tenant` policy is `USING (true)`.
 * A policy, never a bypass: neither login role holds `BYPASSRLS`. It reads
 * `role` and writes Redis; it writes no row.
 *
 * **It never fails the boot.** A Postgres that is not there yet is retried with
 * a backoff. What is lost while disconnected is recovered by recomputing every
 * role on each connect — notifications are not queued for a listener that was
 * away. Until the first connect succeeds the keys are simply absent, and an
 * absent key refuses nobody.
 */
@Injectable()
export class PermissionNotificationsListener extends PgNotificationListener {
  protected readonly channel = PERMISSIONS_CHANNEL;
  protected readonly logger = new Logger(PermissionNotificationsListener.name);

  constructor(
    private readonly prisma: CrossTenantPrismaService,
    private readonly store: PermissionStateStore,
    @Inject(PERMISSIONS_LISTEN_CLIENT)
    newClient: NotificationClientFactory,
  ) {
    super(newClient);
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
}

function fingerprintOf(role: RoleRow): string {
  return permissionFingerprint(role.rolePermissions.map((rp) => rp.permission.key));
}
