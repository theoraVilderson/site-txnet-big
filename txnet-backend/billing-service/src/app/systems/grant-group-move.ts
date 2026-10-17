import { Injectable, Logger } from '@nestjs/common';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { ConfigMoveJobView, jobOutcomes, moveJobView, stopJob } from '../payment/gift/config-move-job';
import { countGroupMove, findGroupMove, GroupMoveScope, startGroupMove } from '../payment/gift/grant-group-move-job';
import { GrantGroupMoveJobBody, GrantGroupMoveSelection, GrantRegroupBody } from '../payment/gift/grant-group-move.schema';
import { GrantBulkPage } from '../payment/gift/grant-bulk-job.schema';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { GrantRegroupActs, GrantRegroupRefused, Regrouped } from '../traffic/grant-regroup';
import { GrantGroupMoveCount } from '../traffic/grant-regroup-selection';
import { ReleaseActor } from './inbound-release';
import { panelScopeOf, SystemsActor } from './panel-scope';

const auditActor = (actor: ReleaseActor) => ({ userId: actor.adminId, ip: actor.ip });

/**
 * The platform owner moves Grants to another panel group (F-027-et, ADR-0127
 * decision 5): **any group** — the platform's, or the Grant's own tenant's,
 * as `grant_panel_group_fits` holds — and any tenant's Grants, one now or many
 * as a `to_group` config move job. Never bounded by a reseller's limits: the
 * platform's decision. One Grant runs in its own tenant; the job is the
 * owner's tenant's and each Grant is moved in its own (the drain).
 */
@Injectable()
export class GrantGroupMoveService {
  private readonly logger = new Logger(GrantGroupMoveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly acts: GrantRegroupActs,
  ) {}

  async one(actor: ReleaseActor, grantId: string, body: GrantRegroupBody): Promise<Regrouped> {
    await panelScopeOf(this.prisma, actor);
    const grant = await this.crossTenant.grant.findUnique({ where: { id: grantId }, select: { tenantId: true } });
    if (!grant) throw new GrantRegroupRefused('grant_not_found', grantId);
    const done = await runWithTenant({ id: grant.tenantId }, () =>
      tenantTransaction(this.prisma, (tx) => this.acts.regroup(tx, { grantId, toGroupId: body.toGroupId, actor: auditActor(actor), reason: body.reason, bounded: false })),
    );
    this.logger.log(`grant ${grantId}: group ${done.fromGroupId} -> ${done.toGroupId} (${done.kept} kept, ${done.moved} moved), by ${actor.adminId}`);
    return done;
  }

  async count(actor: SystemsActor, selection: GrantGroupMoveSelection): Promise<GrantGroupMoveCount> {
    const scope = await this.scope(actor);
    return this.crossTenant.$transaction((tx) => countGroupMove(tx, scope, selection));
  }

  async start(actor: ReleaseActor, body: GrantGroupMoveJobBody): Promise<ConfigMoveJobView> {
    const scope = await this.scope(actor);
    const job = await startGroupMove((work) => this.crossTenant.$transaction(work), scope, auditActor(actor), body);
    this.logger.log(`group move job ${job.id} to ${body.toGroupId}: ${job.total} Grant(s), by ${actor.adminId}`);
    return job;
  }

  job(actor: SystemsActor, jobId: string): Promise<ConfigMoveJobView> {
    return this.crossTenant.$transaction(async (tx) => moveJobView(await findGroupMove(tx, actor.tenantId, jobId)));
  }

  outcomes(actor: SystemsActor, jobId: string, page: GrantBulkPage) {
    return this.crossTenant.$transaction(async (tx) => jobOutcomes(tx, await findGroupMove(tx, actor.tenantId, jobId), page));
  }

  /** Stops the job: the Grants it moved stay moved, the rest are never reached. */
  cancel(actor: ReleaseActor, jobId: string): Promise<ConfigMoveJobView> {
    return this.crossTenant.$transaction(async (tx) => moveJobView(await stopJob(tx, auditActor(actor), await findGroupMove(tx, actor.tenantId, jobId))));
  }

  /** The owner only (`panelScopeOf`); every tenant's Grants, any group. */
  private async scope(actor: SystemsActor): Promise<GroupMoveScope> {
    await panelScopeOf(this.prisma, actor);
    return { jobTenantId: actor.tenantId, scopeTenantId: null, groupWhere: {} };
  }
}
