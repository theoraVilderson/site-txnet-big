import { Injectable } from '@nestjs/common';
import { ConfigMoveJobKind, Prisma } from '@prisma/client';
import { AdmittedReseller, ResellerAccess, ResellerAccessRefused, ResellerActor, SupportConsentRefused, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { GrantRegroupActs, GrantRegroupRefused, Regrouped } from '../../traffic/grant-regroup';
import { GrantGroupMoveCount } from '../../traffic/grant-regroup-selection';
import { ConfigMoveJobView, jobOutcomes, moveJobView, stopJob } from './config-move-job';
import { countGroupMove, findGroupMove, GroupMoveScope, startGroupMove } from './grant-group-move-job';
import { GrantGroupMoveJobBody, GrantGroupMoveSelection, GrantRegroupBody } from './grant-group-move.schema';
import { GrantBulkPage } from './grant-bulk-job.schema';
import { ResellerJobs } from './reseller-job-routes';
import { AdminActor, ResellerUserGrantsRefused } from './reseller-user-grants.service';

/**
 * The groups a reseller may move its users into (F-027-et): **only groups
 * its tenant sells** — named by a variant of its own catalog still for sale,
 * its own groups or the platform's. Moving a user into a group it does not
 * sell would serve them from panels it never offered.
 */
const soldBy = (tenantId: string): Prisma.PanelGroupWhereInput => ({ variants: { some: { tenantId, isActive: true } } });

/**
 * A reseller's admin moves its users' Grants to another panel group (F-027-et,
 * ADR-0127 decision 5): one now, or many as a `to_group` config move job —
 * the Grants ticked, or every Grant of one group. Its own people are bounded
 * by its platform-panel room (ADR-0106); the platform's staff are not, as
 * for an issue. The door is `ResellerAccess` on `grant.assign` — a move can
 * put a user on better panels, so it moves value (grant-keys rule 1).
 */
@Injectable()
export class ResellerGrantGroupMoveService implements ResellerJobs {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
    private readonly acts: GrantRegroupActs,
  ) {}

  one(actor: AdminActor, tenantId: string, userId: string, grantId: string, body: GrantRegroupBody): Promise<Regrouped> {
    return this.admitted(actor, tenantId, 'staffWrite', (admitted) =>
      tenantTransaction(this.prisma, async (tx) => {
        const mine = await tx.grant.findFirst({ where: { id: grantId, userId, tenantId }, select: { id: true } });
        if (!mine) throw new GrantRegroupRefused('grant_not_found', grantId);
        const sold = await tx.panelGroup.findFirst({ where: { id: body.toGroupId, ...soldBy(tenantId) }, select: { id: true } });
        if (!sold) throw new GrantRegroupRefused('group_not_found', body.toGroupId);
        return this.acts.regroup(tx, { grantId, toGroupId: body.toGroupId, actor, reason: body.reason, bounded: admitted.as !== 'staff' });
      }),
    );
  }

  count(actor: ResellerActor, tenantId: string, selection: GrantGroupMoveSelection): Promise<GrantGroupMoveCount> {
    return this.admitted(actor, tenantId, 'read', () => tenantTransaction(this.prisma, (tx) => countGroupMove(tx, scopeOf(tenantId), selection)));
  }

  start(actor: AdminActor, tenantId: string, body: GrantGroupMoveJobBody): Promise<ConfigMoveJobView> {
    return this.admitted(actor, tenantId, 'staffWrite', () => startGroupMove((work) => tenantTransaction(this.prisma, work), scopeOf(tenantId), actor, body));
  }

  /** The reseller's group moves, newest first. */
  list(actor: ResellerActor, tenantId: string, page: Pick<GrantBulkPage, 'page' | 'pageSize'>) {
    const { page: p = 1, pageSize = 20 } = page;
    return this.admitted(actor, tenantId, 'read', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const where = { tenantId, kind: ConfigMoveJobKind.to_group };
        const [rows, total] = await Promise.all([
          tx.configMoveJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (p - 1) * pageSize, take: pageSize }),
          tx.configMoveJob.count({ where }),
        ]);
        return { rows: rows.map(moveJobView), page: p, pageSize, total };
      }),
    );
  }

  job(actor: ResellerActor, tenantId: string, jobId: string): Promise<ConfigMoveJobView> {
    return this.admitted(actor, tenantId, 'read', () => tenantTransaction(this.prisma, async (tx) => moveJobView(await findGroupMove(tx, tenantId, jobId))));
  }

  /** The Grants a job has reached; `problems` keeps the refused and failed, each with its reason. */
  outcomes(actor: ResellerActor, tenantId: string, jobId: string, page: GrantBulkPage) {
    return this.admitted(actor, tenantId, 'read', () => tenantTransaction(this.prisma, async (tx) => jobOutcomes(tx, await findGroupMove(tx, tenantId, jobId), page)));
  }

  /** Stops a running job: the Grants it moved stay moved, the rest are never reached. */
  cancel(actor: AdminActor, tenantId: string, jobId: string): Promise<ConfigMoveJobView> {
    return this.admitted(actor, tenantId, 'staffWrite', () => tenantTransaction(this.prisma, async (tx) => moveJobView(await stopJob(tx, actor, await findGroupMove(tx, tenantId, jobId)))));
  }

  private async admitted<T>(actor: ResellerActor, tenantId: string, capability: 'read' | 'staffWrite', work: (admitted: AdmittedReseller) => Promise<T>): Promise<T> {
    try {
      return await this.access.for('grant.assign').runIncludingPlatform(actor, tenantId, capability, work);
    } catch (e) {
      if (e instanceof ResellerAccessRefused || e instanceof SupportConsentRefused) throw new ResellerUserGrantsRefused(e.reason, tenantId);
      throw e;
    }
  }
}

/** The reseller's own Grants, into the groups it sells; the job is its own. */
const scopeOf = (tenantId: string): GroupMoveScope => ({ jobTenantId: tenantId, scopeTenantId: tenantId, groupWhere: soldBy(tenantId) });
