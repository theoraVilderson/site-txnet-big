import { Injectable, Logger } from '@nestjs/common';
import { ConfigStatus, PanelReviewState, PanelTransport, Prisma } from '@prisma/client';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { panelScopeOf, SystemsActor } from './panel-scope';
import { SystemsRefused } from './systems-read';

/** A panel's own settings, as the owner edits them (F-027-by). Any of them, at least one. */
export type PanelSettingsInput = {
  name?: string;
  region?: string;
  ipAddress?: string | null;
  apiBaseUrl?: string;
  clientBaseUrl?: string | null;
  maxRequestsPerMinute?: number;
};

/** The addresses the connection test reached: changing one may point at another server. */
const TESTED_ADDRESSES = ['apiBaseUrl', 'clientBaseUrl'] as const;

/**
 * A registered panel's life after registration, on the systems surface
 * (`billing/contract.panel-lifecycle.md`): editing its settings, deleting it —
 * or archiving it when it has history — and restoring an archived one.
 *
 * Desired state, as every route here: nothing calls `network-service`
 * (ADR-0071). A changed address sends the panel back to `pending` with its
 * last test cleared, and the next tick tests the new one
 * (`network/contract.registration.md` rule 4). Writes go through the
 * cross-tenant pool after `panelScopeOf`, as in `PanelRegistrationService`: a
 * platform panel's `tenantId` is null, and the app pool's `WITH CHECK` refuses it.
 */
@Injectable()
export class PanelLifecycleService {
  private readonly logger = new Logger(PanelLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** The platform owner's pool, for the panel writes only. */
    private readonly all: CrossTenantPrismaService,
  ) {}

  /**
   * Only what the body names is written. An address that differs from the
   * stored one is a re-test — of an accepted panel too, since its verdict was
   * about the old server, and of a refused one, since the new server has not
   * been asked. A push panel is never called: it takes no API or link address
   * and cannot drop the IP its NAS is allowlisted by (`not_for_transport`).
   */
  async update(actor: SystemsActor, panelId: string, input: PanelSettingsInput) {
    const scope = await panelScopeOf(this.prisma, actor);
    const where = { id: panelId, ...scope };
    const panel = await this.prisma.panel.findFirst({
      where,
      select: { transport: true, reviewState: true, apiBaseUrl: true, clientBaseUrl: true, retiredAt: true },
    });
    if (!panel) throw new SystemsRefused('not_found');
    if (panel.retiredAt !== null) throw new SystemsRefused('panel_retired');

    if (panel.transport === PanelTransport.push) {
      const pullOnly = input.apiBaseUrl !== undefined || (input.clientBaseUrl !== undefined && input.clientBaseUrl !== null);
      if (pullOnly || input.ipAddress === null) throw new SystemsRefused('not_for_transport');
    }

    const retest = TESTED_ADDRESSES.some((k) => input[k] !== undefined && input[k] !== panel[k]);
    const data = {
      ...input,
      ...(retest
        ? { reviewState: PanelReviewState.pending, connectionTestedAt: null, connectionTestFault: null, connectionTestDetail: null }
        : {}),
    };
    const { count } = await this.all.panel.updateMany({ where: { ...where, retiredAt: null }, data });
    if (count === 0) throw new SystemsRefused('panel_retired');

    this.logger.log(`panel ${panelId} edited by ${actor.adminId}${retest ? '; address changed, re-tested on the next tick' : ''}`);
    return { id: panelId, reviewState: retest ? PanelReviewState.pending : panel.reviewState, retest };
  }

  /**
   * Delete a panel (F-027-bz, user 2026-09-25): one with no history is
   * deleted; one with history is archived — `retiredAt` set, every
   * `network-service` loop skips it, its rows stay. Either way refused while a
   * group holds it (`panel_in_group`: remove or drain the member first) or a
   * config on it is live (`panel_has_configs`). The archive holds both
   * conditions in its own `UPDATE`; a key the history check did not see (the
   * delete fails on it) archives instead of failing.
   */
  async remove(actor: SystemsActor, panelId: string) {
    const scope = await panelScopeOf(this.prisma, actor);
    const panel = await this.prisma.panel.findFirst({ where: { id: panelId, ...scope }, select: { retiredAt: true } });
    if (!panel) throw new SystemsRefused('not_found');
    if (panel.retiredAt !== null) throw new SystemsRefused('panel_retired');
    await this.refuseInService(panelId);

    if (!(await this.hasHistory(panelId))) {
      try {
        const { count } = await this.all.panel.deleteMany({ where: { id: panelId, ...scope, retiredAt: null } });
        if (count > 0) {
          // Its login stays in the vault under an id nothing names: unreachable, as after a failed registration.
          this.logger.log(`panel ${panelId} deleted by ${actor.adminId}; it had no history`);
          return { id: panelId, outcome: 'deleted' as const };
        }
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003')) throw e;
      }
    }

    const archived = await this.all.$executeRaw`UPDATE "network"."panel" p SET "retiredAt" = now()
       WHERE p."id" = ${panelId}::uuid AND p."ownershipType" = ${scope.ownershipType}::"network"."PanelOwnershipType"
         AND p."tenantId" IS NOT DISTINCT FROM ${scope.tenantId}::uuid AND p."retiredAt" IS NULL
         AND NOT EXISTS (SELECT 1 FROM "network"."panel_group_member" m WHERE m."panelId" = p."id")
         AND NOT EXISTS (SELECT 1 FROM "network"."config" c WHERE c."panelId" = p."id" AND c."status" <> 'retired')`;
    if (archived === 0) {
      await this.refuseInService(panelId);
      throw new SystemsRefused('panel_retired');
    }
    this.logger.log(`panel ${panelId} archived by ${actor.adminId}; its history stays`);
    return { id: panelId, outcome: 'archived' as const };
  }

  /**
   * Bring an archived panel back. It returns `pending`, its last test cleared:
   * it may have been down for months, and collection waits for a fresh verdict.
   */
  async restore(actor: SystemsActor, panelId: string) {
    const scope = await panelScopeOf(this.prisma, actor);
    const where = { id: panelId, ...scope };
    const { count } = await this.all.panel.updateMany({
      where: { ...where, retiredAt: { not: null } },
      data: { retiredAt: null, reviewState: PanelReviewState.pending, connectionTestedAt: null, connectionTestFault: null, connectionTestDetail: null },
    });
    if (count === 0) {
      const panel = await this.prisma.panel.findFirst({ where, select: { retiredAt: true } });
      throw new SystemsRefused(panel ? 'panel_not_retired' : 'not_found');
    }
    this.logger.log(`panel ${panelId} restored by ${actor.adminId}; re-tested on the next tick`);
    return { id: panelId, reviewState: PanelReviewState.pending };
  }

  private async refuseInService(panelId: string) {
    if (await this.all.panelGroupMember.findFirst({ where: { panelId }, select: { panelId: true } })) throw new SystemsRefused('panel_in_group');
    const live = await this.all.config.findFirst({ where: { panelId, status: { not: ConfigStatus.retired } }, select: { id: true } });
    if (live) throw new SystemsRefused('panel_has_configs');
  }

  /** Any row that names the panel: a config in any state, usage, a hold, drift, or an HA partner. */
  private async hasHistory(panelId: string): Promise<boolean> {
    const [row] = await this.all.$queryRaw<Array<{ history: boolean }>>`SELECT
         EXISTS (SELECT 1 FROM "network"."config" WHERE "panelId" = ${panelId}::uuid)
      OR EXISTS (SELECT 1 FROM "network"."config_counter_state" WHERE "panelId" = ${panelId}::uuid)
      OR EXISTS (SELECT 1 FROM "network"."usage_delta_seen" WHERE "panelId" = ${panelId}::uuid)
      OR EXISTS (SELECT 1 FROM "network"."usage_delta_quarantine" WHERE "panelId" = ${panelId}::uuid)
      OR EXISTS (SELECT 1 FROM "network"."usage_hold" WHERE "panelId" = ${panelId}::uuid)
      OR EXISTS (SELECT 1 FROM "network"."panel_drift_event" WHERE "panelId" = ${panelId}::uuid)
      OR EXISTS (SELECT 1 FROM "network"."unattributed_usage" WHERE "panelId" = ${panelId}::uuid)
      OR EXISTS (SELECT 1 FROM "network"."radius_session" WHERE "panelId" = ${panelId}::uuid)
      OR EXISTS (SELECT 1 FROM "network"."panel" WHERE "pairedPanelId" = ${panelId}::uuid) AS history`;
    return row?.history ?? true;
  }
}
