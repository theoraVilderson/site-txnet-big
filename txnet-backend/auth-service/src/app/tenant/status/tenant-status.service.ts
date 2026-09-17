import { Injectable, Logger } from '@nestjs/common';
import { AdminAction, AuditTargetType, Prisma, TenantStatus, TenantSuspensionCause, TenantType } from '@prisma/client';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { ChangeTenantStatusInput } from './tenant-status.schema';
import { applyTenantStatus } from './tenant-status.transition';

/**
 * The platform owner suspends, reactivates and terminates a reseller (F-018-f,
 * D-42 (1)). What each status allows is `TenantStatusPolicy` in shared-core;
 * this only moves a tenant between them and leaves the trail.
 *
 * **One transaction under the tenant row's lock:** the status read, the
 * `tenant` update, one `tenant_status_history` row and one audit row. The
 * trigger on `tenant.tenant` then notifies, and `TenantStatusListener` writes
 * Redis — after commit, so a rolled-back change is never enforced.
 *
 * Suspending stamps `suspendedAt` = now and `graceEndsAt` = now +
 * `suspensionHoldDays`, cause `manual`; reactivating clears them
 * (`tenant-status.transition.ts`, shared with the renewal). `terminated` is
 * final. Nothing is deleted by any of it.
 */

export type TenantStatusActor = { adminId: string; tenantId: string; ip: string };

export type TenantStatusView = {
  tenantId: string;
  status: TenantStatus;
  suspendedAt: Date | null;
  graceEndsAt: Date | null;
  suspendedReason: string | null;
};

export type TenantStatusHistoryView = {
  fromStatus: TenantStatus;
  toStatus: TenantStatus;
  reason: string | null;
  actorUserId: string | null;
  createdAt: Date;
};

export type TenantStatusRejection = 'not_platform_owner' | 'reseller_not_found' | 'reseller_terminated' | 'status_unchanged';

export class TenantStatusRefused extends Error {
  constructor(
    readonly reason: TenantStatusRejection,
    detail = '',
  ) {
    super(`tenant status refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'TenantStatusRefused';
  }
}

/** The platform's one settings row (migration `20260917001300_tenant_subscription`). */
const SETTINGS_ID = 1;
const HISTORY_LIMIT = 100;

type LockedTenant = {
  id: string;
  tenantType: TenantType;
  status: TenantStatus;
  suspendedAt: Date | null;
  graceEndsAt: Date | null;
};

@Injectable()
export class TenantStatusService {
  private readonly logger = new Logger(TenantStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
  ) {}

  async change(actor: TenantStatusActor, tenantId: string, input: ChangeTenantStatusInput): Promise<TenantStatusView> {
    await this.access(actor);
    const holdDays = input.status === TenantStatus.suspended ? await this.holdDays() : 0;
    const view = await this.all.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<LockedTenant[]>`
        SELECT id, "tenantType", status, "suspendedAt", "graceEndsAt"
        FROM "tenant"."tenant"
        WHERE id = ${tenantId}::uuid AND "deletedAt" IS NULL
        FOR UPDATE`;
      if (!row || row.tenantType !== TenantType.reseller) throw new TenantStatusRefused('reseller_not_found', tenantId);
      if (row.status === TenantStatus.terminated) throw new TenantStatusRefused('reseller_terminated', tenantId);
      if (row.status === input.status) throw new TenantStatusRefused('status_unchanged', input.status);

      const reason = input.reason ?? null;
      const after = await applyTenantStatus(tx, tenantId, {
        from: row.status,
        to: input.status,
        reason,
        actorUserId: actor.adminId,
        cause: TenantSuspensionCause.manual,
        holdDays,
        now: new Date(),
      });
      const result: TenantStatusView = {
        tenantId: after.id,
        status: after.status,
        suspendedAt: after.suspendedAt,
        graceEndsAt: after.graceEndsAt,
        suspendedReason: after.suspendedReason,
      };
      await tx.adminAuditLog.create({
        data: {
          tenantId,
          adminId: actor.adminId,
          action: AdminAction.tenant_status_change,
          targetEntityType: AuditTargetType.tenant,
          targetEntityId: tenantId,
          oldValue: JSON.parse(JSON.stringify({ status: row.status, suspendedAt: row.suspendedAt, graceEndsAt: row.graceEndsAt })) as Prisma.InputJsonValue,
          newValue: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
          adminIpAddress: actor.ip,
        },
      });
      return result;
    });
    this.logger.log(`reseller ${tenantId} -> ${input.status} by ${actor.adminId}`);
    return view;
  }

  async history(actor: TenantStatusActor, tenantId: string): Promise<TenantStatusHistoryView[]> {
    await this.access(actor);
    return this.all.tenantStatusHistory.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
      select: { fromStatus: true, toStatus: true, reason: true, actorUserId: true, createdAt: true },
    });
  }

  private async holdDays(): Promise<number> {
    const row = await this.all.tenantSubscriptionSetting.findUnique({ where: { id: SETTINGS_ID }, select: { suspensionHoldDays: true } });
    if (!row) throw new Error('tenant_subscription_setting row is missing — run the migrations');
    return row.suspensionHoldDays;
  }

  /** The platform owner's tenant — the same check as reseller administration. */
  private async access(actor: TenantStatusActor): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    if (tenant?.tenantType !== TenantType.platform_owner) {
      throw new TenantStatusRefused('not_platform_owner', 'status administration');
    }
  }
}
