import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  NotificationClientFactory,
  PgNotificationListener,
  TenantStatusValue,
  UnscopedRedisKeys,
  serializeTenantStatusState,
} from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { RedisService } from '../redis/redis.service';

/** The channel `20260917001500_tenant_status` writes to. */
export const TENANT_STATUS_CHANNEL = 'tenant_status_changed';

export const TENANT_STATUS_LISTEN_CLIENT = Symbol('TENANT_STATUS_LISTEN_CLIENT');

const STATE = { id: true, status: true, graceEndsAt: true } as const;
type StateRow = { id: string; status: TenantStatusValue; graceEndsAt: Date | null };

/**
 * Keeps `tenant:status:<id>` — what `TenantStatusGuard` reads in every service —
 * in step with `tenant.tenant` (F-018-f, F-101-b's pattern). It moved here with
 * the status routes it follows (F-018-w, ADR-0058); every other service only
 * reads that key.
 *
 * The trigger fires on any change of `status` or `graceEndsAt`, by this
 * service's status route, by its renewal or by hand in SQL. Tenants are read on
 * the cross-tenant pool: the rows are every tenant's. A soft-deleted tenant's
 * key is written like any other; it resolves nowhere anyway.
 */
@Injectable()
export class TenantStatusListener extends PgNotificationListener {
  protected readonly channel = TENANT_STATUS_CHANNEL;
  protected readonly logger = new Logger(TenantStatusListener.name);

  constructor(
    private readonly all: CrossTenantPrismaService,
    private readonly redis: RedisService,
    @Inject(TENANT_STATUS_LISTEN_CLIENT) newClient: NotificationClientFactory,
  ) {
    super(newClient);
  }

  async handle(payload: string | undefined): Promise<void> {
    let tenantId: unknown;
    try {
      tenantId = (JSON.parse(payload ?? '') as { tenantId?: unknown }).tenantId;
    } catch {
      this.logger.warn('ignored a tenant status notification that is not JSON');
      return;
    }
    if (typeof tenantId !== 'string') {
      this.logger.warn('ignored a tenant status notification of an unknown shape');
      return;
    }
    try {
      const row = await this.all.tenant.findUnique({ where: { id: tenantId }, select: STATE });
      if (!row) return;
      await this.write(row);
      // After the key: `gateway-service` re-reads it on this message and closes
      // the tenant's sockets if it no longer reads (F-018-r). Only a change is
      // announced — its re-check tick covers `recomputeAll` and a lost message.
      await this.redis.publish(UnscopedRedisKeys.tenantStatusChanged(), row.id);
    } catch (error) {
      // The old key stays — the state before this change. The next connect recomputes it.
      this.logger.error(`tenant status notification not applied: ${(error as Error).message}`);
    }
  }

  async recomputeAll(): Promise<void> {
    const rows = await this.all.tenant.findMany({ select: STATE });
    for (const row of rows) await this.write(row);
  }

  private write(row: StateRow): Promise<void> {
    return this.redis.set(
      UnscopedRedisKeys.tenantStatus(row.id),
      serializeTenantStatusState({
        status: row.status,
        graceEndsAt: row.graceEndsAt ? row.graceEndsAt.toISOString() : null,
      }),
    );
  }
}
