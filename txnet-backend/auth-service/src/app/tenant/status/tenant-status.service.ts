import { Injectable, Logger } from '@nestjs/common';
import { AdminAction, AuditTargetType, Prisma, TenantStatus, TenantSuspensionCause, TenantType } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { ChangeTenantStatusInput } from './tenant-status.schema';
import { applyTenantStatus, makeSuspensionManual } from './tenant-status.transition';

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
 *
 * Suspending a reseller already suspended **for non-payment** is not
 * `status_unchanged`: it makes the cause `manual`, so a later payment renews
 * the subscription but does not reopen the panel (F-018-s).
 *
 * `stopCampaigns` (F-018-q) writes a `tenant.campaigns.stop_requested` outbox
 * event in the same transaction: notification-service owns campaigns and stops
 * them when `worker-service` delivers it, retried until it lands. A change that
 * rolls back asks for nothing; one that commits cannot lose the ask.
 */

export type TenantStatusActor = { adminId: string; tenantId: string; ip: string };

export type TenantStatusView = {
  tenantId: string;
  status: TenantStatus;
  /** Why it is suspended: `manual` or `non_payment` (a payment lifts only that); null unless suspended. */
  suspensionCause: TenantSuspensionCause | null;
  suspendedAt: Date | null;
  graceEndsAt: Date | null;
  suspendedReason: string | null;
  /** F-018-q: whether this change asked for the reseller's sending campaigns to stop. */
  stopCampaigns: boolean;
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
  suspensionCause: TenantSuspensionCause | null;
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
        SELECT id, "tenantType", status, "suspensionCause", "suspendedAt", "graceEndsAt"
        FROM "tenant"."tenant"
        WHERE id = ${tenantId}::uuid AND "deletedAt" IS NULL
        FOR UPDATE`;
      if (!row || row.tenantType !== TenantType.reseller) throw new TenantStatusRefused('reseller_not_found', tenantId);
      if (row.status === TenantStatus.terminated) throw new TenantStatusRefused('reseller_terminated', tenantId);
      const reason = input.reason ?? null;
      const toManual =
        row.status === TenantStatus.suspended && input.status === TenantStatus.suspended && row.suspensionCause === TenantSuspensionCause.non_payment;
      if (row.status === input.status && !toManual) throw new TenantStatusRefused('status_unchanged', input.status);

      const after = toManual
        ? await makeSuspensionManual(tx, tenantId, { reason, actorUserId: actor.adminId })
        : await applyTenantStatus(tx, tenantId, {
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
        suspensionCause: after.suspensionCause,
        suspendedAt: after.suspendedAt,
        graceEndsAt: after.graceEndsAt,
        suspendedReason: after.suspendedReason,
        stopCampaigns: input.stopCampaigns === true,
      };
      await tx.adminAuditLog.create({
        data: {
          tenantId,
          adminId: actor.adminId,
          action: AdminAction.tenant_status_change,
          targetEntityType: AuditTargetType.tenant,
          targetEntityId: tenantId,
          oldValue: JSON.parse(JSON.stringify({ status: row.status, suspensionCause: row.suspensionCause, suspendedAt: row.suspendedAt, graceEndsAt: row.graceEndsAt })) as Prisma.InputJsonValue,
          newValue: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
          adminIpAddress: actor.ip,
        },
      });
      if (result.stopCampaigns) {
        await tx.outboxEvent.create({
          data: { aggregate: 'tenant', aggregateId: tenantId, type: OutboxEventType.TENANT_CAMPAIGNS_STOP_REQUESTED, payload: { tenantId } },
          select: { id: true },
        });
      }
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
