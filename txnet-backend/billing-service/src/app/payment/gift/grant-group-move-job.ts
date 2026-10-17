import { ConfigMoveJob, ConfigMoveJobKind, Prisma } from '@prisma/client';

import { AuditActor, auditMoveJob } from '../../grant-audit/grant-audit';
import { GrantRegroupRefused } from '../../traffic/grant-regroup';
import { countRegroupSelection, GrantGroupMoveCount, insertRegroupSelection } from '../../traffic/grant-regroup-selection';
import { CONFIG_MOVE_JOB_MAX_CONFIGS, ConfigMoveJobRefused, ConfigMoveJobView, moveJobView } from './config-move-job';
import { GrantGroupMoveJobBody, GrantGroupMoveSelection } from './grant-group-move.schema';
import { bulkFingerprint } from './reseller-grants-bulk';

/**
 * Who a group move is started by and over what (F-027-et): the job is
 * `jobTenantId`'s; the Grants are `scopeTenantId`'s, or every tenant's for the
 * platform owner (null). `groupWhere` is the targets the actor may name.
 */
export type GroupMoveScope = { jobTenantId: string; scopeTenantId: string | null; groupWhere: Prisma.PanelGroupWhereInput };

const isDuplicate = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** The target, one the actor may name; any other reads as absent. */
async function assertTarget(tx: Prisma.TransactionClient, scope: GroupMoveScope, toGroupId: string) {
  const group = await tx.panelGroup.findFirst({ where: { id: toGroupId, ...scope.groupWhere }, select: { id: true } });
  if (!group) throw new GrantRegroupRefused('group_not_found', toGroupId);
}

/** The confirm's figures for a group move: Grants, and their configs kept and moved. */
export async function countGroupMove(tx: Prisma.TransactionClient, scope: GroupMoveScope, selection: GrantGroupMoveSelection): Promise<GrantGroupMoveCount> {
  await assertTarget(tx, scope, selection.toGroupId);
  return countRegroupSelection(tx, scope.scopeTenantId, selection.source, selection.toGroupId);
}

/**
 * Starts a group move (F-027-et) as a `to_group` config move job. **The
 * selection is frozen at the confirm**: one item per Grant, at most
 * `CONFIG_MOVE_JOB_MAX_CONFIGS`, in the start's transaction. **One
 * `requestId`, one job**: the same body again answers it, another is
 * `request_reused`, and a concurrent repeat that loses the key answers the
 * winner's job. Written down once (`config_move_start`).
 */
export async function startGroupMove(
  transaction: <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>,
  scope: GroupMoveScope,
  actor: AuditActor,
  body: GrantGroupMoveJobBody,
): Promise<ConfigMoveJobView> {
  const { requestId, ...command } = body;
  const fingerprint = bulkFingerprint(command);
  const key = { tenantId_requestId: { tenantId: scope.jobTenantId, requestId } };
  try {
    return await transaction(async (tx) => {
      const prior = await tx.configMoveJob.findUnique({ where: key });
      if (prior) return sameOrReused(prior, fingerprint);
      await assertTarget(tx, scope, command.toGroupId);
      const job = await tx.configMoveJob.create({
        data: { tenantId: scope.jobTenantId, requestId, fingerprint, actorUserId: actor.userId, actorIp: actor.ip, reason: command.reason, kind: ConfigMoveJobKind.to_group, source: command.source, toGroupId: command.toGroupId, total: 0 },
      });
      const total = await insertRegroupSelection(tx, job.id, scope.scopeTenantId, command.source, command.toGroupId, CONFIG_MOVE_JOB_MAX_CONFIGS + 1);
      if (total === 0) throw new ConfigMoveJobRefused('selection_empty');
      if (total > CONFIG_MOVE_JOB_MAX_CONFIGS) throw new ConfigMoveJobRefused('selection_too_large', String(CONFIG_MOVE_JOB_MAX_CONFIGS));
      const started = await tx.configMoveJob.update({ where: { id: job.id }, data: { total } });
      await auditMoveJob(tx, actor, scope.jobTenantId, 'config_move_start', job.id, null, { source: command.source, toGroupId: command.toGroupId, kind: started.kind, total }, command.reason);
      return moveJobView(started);
    });
  } catch (e) {
    if (!isDuplicate(e)) throw e;
    const prior = await transaction((tx) => tx.configMoveJob.findUnique({ where: key }));
    if (!prior) throw e;
    return sameOrReused(prior, fingerprint);
  }
}

/** A group move job of `jobTenantId`; any other — another tenant's, or another kind — reads as absent. */
export async function findGroupMove(tx: Prisma.TransactionClient, jobTenantId: string, jobId: string): Promise<ConfigMoveJob> {
  const job = await tx.configMoveJob.findFirst({ where: { id: jobId, tenantId: jobTenantId, kind: ConfigMoveJobKind.to_group } });
  if (!job) throw new ConfigMoveJobRefused('job_not_found', jobId);
  return job;
}

function sameOrReused(prior: ConfigMoveJob, fingerprint: string): ConfigMoveJobView {
  if (prior.fingerprint !== fingerprint) throw new ConfigMoveJobRefused('request_reused', prior.requestId);
  return moveJobView(prior);
}
