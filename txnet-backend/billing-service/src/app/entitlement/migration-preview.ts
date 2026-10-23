import { Injectable, Logger } from '@nestjs/common';
import { GrantSource, MigrationRunKind, MigrationRunStatus, type DriverType, type MigrationRun, type Prisma } from '@prisma/client';
import { endUserRoom, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { trafficQuotaOf } from '../catalog/traffic-quota';
import { errorLine } from '../log-line';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { balancePlanOf, balanceRowsOf } from '../wallet/balance-import-plan';
import { linkPlanOf, readLinkRun } from './migration-link-run';
import { remoteIdentityOf } from './migration-plan';
import { announceRun } from './migration-run-view';
import { clientsPerInbound, planRun, type RunPlan } from './migration-run-plan';
import { MigrationSeamRefused, SourceSnapshotReader, SubscriptionLinkProbe, type SourceRead, type SourceSnapshot } from './migration-seams';

/** How long a tick holds a run: past it, a tick that died mid-read is taken over (F-206). */
export const MIGRATION_RUN_LEASE_MS = 10 * 60_000;
/** Items written per statement: a 20 000-client source is twenty inserts. */
const ITEM_INSERT_CHUNK = 1_000;
/** The write of a whole report: up to 20 000 rows in one transaction, so the report is all or nothing. */
const REPORT_WRITE_TIMEOUT_MS = 60_000;

/** Why a preview went back to `draft` though the source answered: an inbound with clients has no variant yet. */
export const INBOUNDS_UNMAPPED = 'inbounds_unmapped';
/** The source could not be asked at all (network-service unset or down); retried by previewing again. */
const SOURCE_UNREACHABLE = 'source_unavailable';

/** The run a tick may take: in `status`, and not held by a live lease. */
export const claimableRun = (status: MigrationRunStatus, now: Date): Prisma.MigrationRunWhereInput => ({
  status,
  OR: [{ workerClaimedAt: null }, { workerClaimedAt: { lt: new Date(now.getTime() - MIGRATION_RUN_LEASE_MS) } }],
});

/**
 * Takes one run in `status` for this tick, oldest first: a conditional write
 * of the lease on what was read, so two ticks never take the same run.
 */
export async function claimRun(db: CrossTenantPrismaService, status: MigrationRunStatus, now: Date): Promise<MigrationRun | null> {
  const run = await db.migrationRun.findFirst({ where: claimableRun(status, now), orderBy: { updatedAt: 'asc' } });
  if (!run) return null;
  const { count } = await db.migrationRun.updateMany({ where: { id: run.id, ...claimableRun(status, now) }, data: { workerClaimedAt: now } });
  return count === 1 ? { ...run, workerClaimedAt: now } : null;
}

/** The run is still this tick's: in `status`, under the lease it took. A cancel or a re-preview meanwhile is theirs. */
export const stillOurs = (run: MigrationRun, status: MigrationRunStatus): Prisma.MigrationRunWhereInput => ({ id: run.id, status, workerClaimedAt: run.workerClaimedAt });

/** Where a panel run is read from: its registered panel in place (ADR-0160), else its source login by the run's id. */
const sourceReadOf = (run: Pick<MigrationRun, 'id' | 'sourcePanelId'>): SourceRead => (run.sourcePanelId ? { panelId: run.sourcePanelId } : { credentialRef: run.id });

export type MigrationPreviewResult = 'none' | 'previewed' | 'returned' | 'lost';

/** A panel run's source; `migration_run_source_fits_kind` holds both on every panel run, so a missing one is a broken row. */
export function panelSourceOf(run: Pick<MigrationRun, 'id' | 'sourceFamily' | 'sourceAddress'>): { family: DriverType; sourceAddress: string } {
  if (!run.sourceFamily || !run.sourceAddress) throw new Error(`run ${run.id} names no source panel`);
  return { family: run.sourceFamily, sourceAddress: run.sourceAddress };
}

/**
 * The dry run (F-206, entitlement `contract.import.md`): one `previewing` run
 * per call, by `worker-service`'s tick over the internal seam (ADR-0027).
 *
 * 1. The source is read once — network-service's snapshot, the bulk calls
 *    only (network rule 4) — outside any transaction.
 * 2. Its inbounds are recorded with their client counts. One with clients and
 *    no variant sends the run back to `draft` (`inbounds_unmapped`): the
 *    first preview is how the reseller learns the inbounds to map.
 * 3. Otherwise each client is planned (`planRun`) against what the tenant
 *    already holds, and the report replaces the last one in one transaction.
 *
 * **Nothing outside the run's tables is written** (invariant 32). A refusal
 * of the source returns the run to `draft` with its reason. Every move is told
 * to the page (C-14). A run cancelled or previewed again meanwhile is left alone.
 */
@Injectable()
export class MigrationPreviewService {
  private readonly logger = new Logger(MigrationPreviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly source: SourceSnapshotReader,
    private readonly links: SubscriptionLinkProbe,
  ) {}

  async previewNext(now: Date = new Date()): Promise<MigrationPreviewResult> {
    const run = await claimRun(this.crossTenant, MigrationRunStatus.previewing, now);
    if (!run) return 'none';
    return runWithTenant({ id: run.tenantId }, () => this.preview(run, now));
  }

  private async preview(run: MigrationRun, now: Date): Promise<MigrationPreviewResult> {
    if (run.kind === MigrationRunKind.link) return this.previewLink(run, now);
    if (run.kind === MigrationRunKind.csv) return this.previewCsv(run);
    let snapshot: SourceSnapshot;
    try {
      snapshot = await this.source.snapshot(run.tenantId, panelSourceOf(run).family, sourceReadOf(run));
    } catch (e) {
      const reason = e instanceof MigrationSeamRefused ? e.reason : SOURCE_UNREACHABLE;
      this.logger.warn(`run ${run.id}: source not read (${reason}): ${errorLine(e)}`);
      return this.returnToDraft(run, reason);
    }

    const unmapped = await tenantTransaction(this.prisma, (tx) => recordInbounds(tx, run, snapshot));
    if (unmapped > 0) return this.returnToDraft(run, INBOUNDS_UNMAPPED);

    const plan = planRun(snapshot.clients, await this.contextOf(run, now));
    const written = await tenantTransaction(this.prisma, (tx) => writeReport(tx, run, plan), { timeout: REPORT_WRITE_TIMEOUT_MS });
    if (!written) return 'lost';
    this.logger.log(`run ${run.id}: previewed ${plan.items.length} client(s): ${plan.plannedCreate} create, ${plan.plannedUpdate} update, ${plan.plannedSkip} skip`);
    return 'previewed';
  }

  /**
   * A link run's dry run (F-201-g): the link read once through network, its
   * one client planned against what the tenant holds, the report written as
   * a panel run's is. A refusal returns the run to `draft` with its reason.
   */
  private async previewLink(run: MigrationRun, now: Date): Promise<MigrationPreviewResult> {
    const read = await readLinkRun(this.links, run, this.logger);
    if ('reason' in read) return this.returnToDraft(run, read.reason);
    const written = await tenantTransaction(this.prisma, async (tx) => writeReport(tx, run, await linkPlanOf(tx, run, { client: read.client, read: read.client, now })));
    if (!written) return 'lost';
    this.logger.log(`run ${run.id}: previewed its link`);
    return 'previewed';
  }

  /**
   * A balance file planned again (F-209-a): its rows as the items keep them,
   * against the tenant's people and wallets now — a name the reseller has
   * since added is found. The file is not handed in again.
   */
  private async previewCsv(run: MigrationRun): Promise<MigrationPreviewResult> {
    const written = await tenantTransaction(this.prisma, async (tx) => writeReport(tx, run, await balancePlanOf(tx, run.tenantId, await balanceRowsOf(tx, run))), { timeout: REPORT_WRITE_TIMEOUT_MS });
    if (!written) return 'lost';
    this.logger.log(`run ${run.id}: previewed its balance file again`);
    return 'previewed';
  }

  /** What the plan asks of the tenant, read in one short transaction before it: the mapping, what is already imported, the room. */
  private contextOf(run: MigrationRun, now: Date) {
    const { family, sourceAddress } = panelSourceOf(run);
    // Every key of this source shares the prefix (`remoteIdentityOf`): one indexed read each, not one per client.
    const prefix = remoteIdentityOf({ family, sourceAddress }, '');
    return tenantTransaction(this.prisma, async (tx) => {
      const [inbounds, grants, users, userRoom] = await Promise.all([
        tx.migrationInbound.findMany({ where: { runId: run.id, variantId: { not: null } }, select: { inboundRemoteId: true, variantId: true } }),
        tx.grant.findMany({ where: { tenantId: run.tenantId, source: GrantSource.migration, remoteIdentity: { startsWith: prefix } }, select: { remoteIdentity: true } }),
        tx.user.findMany({ where: { tenantId: run.tenantId, remoteIdentity: { startsWith: prefix } }, select: { remoteIdentity: true } }),
        endUserRoom(tx, run.tenantId),
      ]);
      const variantOf = new Map(inbounds.flatMap((i) => (i.variantId ? [[i.inboundRemoteId, i.variantId] as const] : [])));
      // Read as the sale shapes a Grant of it (`grantFromVariant`): only a prepaid variant is mapped (rule 10).
      const variants = await tx.productVariant.findMany({ where: { id: { in: [...new Set(variantOf.values())] } }, select: { id: true, quotas: true } });
      return {
        family,
        sourceAddress,
        now,
        variantOf,
        unlimitedVariants: new Set(variants.filter((v) => trafficQuotaOf(v.quotas).kind === 'unlimited').map((v) => v.id)),
        importedGrants: new Set(grants.flatMap((g) => (g.remoteIdentity ? [g.remoteIdentity] : []))),
        importedUsers: new Set(users.flatMap((u) => (u.remoteIdentity ? [u.remoteIdentity] : []))),
        userRoom,
      };
    });
  }

  private async returnToDraft(run: MigrationRun, reason: string): Promise<MigrationPreviewResult> {
    return tenantTransaction(this.prisma, async (tx) => {
      const { count } = await tx.migrationRun.updateMany({ where: stillOurs(run, MigrationRunStatus.previewing), data: { status: MigrationRunStatus.draft, failureReason: reason, workerClaimedAt: null } });
      if (count === 0) return 'lost';
      await announceRun(tx, run);
      return 'returned';
    });
  }
}

/**
 * The snapshot's inbounds, and every inbound a client names, with how many
 * clients each holds; a variant already chosen is kept. An inbound gone from
 * the source is dropped unless it was mapped. Answers how many inbounds with
 * clients have no variant.
 */
export async function recordInbounds(tx: Prisma.TransactionClient, run: MigrationRun, snapshot: SourceSnapshot): Promise<number> {
  const counts = clientsPerInbound(snapshot.clients);
  const read = new Map(snapshot.inbounds.map((i) => [i.remoteId, i]));
  for (const id of counts.keys()) if (!read.has(id)) read.set(id, { remoteId: id, tag: '', protocol: '' });
  await tx.migrationInbound.deleteMany({ where: { runId: run.id, variantId: null, inboundRemoteId: { notIn: [...read.keys()] } } });
  // One write per inbound: a source holds a handful, and each keeps its own chosen variant.
  for (const i of read.values()) {
    const fields = { tag: i.tag, protocol: i.protocol, clientCount: counts.get(i.remoteId) ?? 0 };
    await tx.migrationInbound.upsert({
      where: { runId_inboundRemoteId: { runId: run.id, inboundRemoteId: i.remoteId } },
      create: { runId: run.id, tenantId: run.tenantId, inboundRemoteId: i.remoteId, ...fields },
      update: fields,
    });
  }
  return tx.migrationInbound.count({ where: { runId: run.id, variantId: null, clientCount: { gt: 0 } } });
}

/** The report replaces the last one, conditional on the run still being this tick's; false when it was not. */
export async function writeReport(tx: Prisma.TransactionClient, run: MigrationRun, plan: RunPlan): Promise<boolean> {
  const { count } = await tx.migrationRun.updateMany({
    where: stillOurs(run, MigrationRunStatus.previewing),
    data: { status: MigrationRunStatus.previewed, failureReason: null, workerClaimedAt: null, plannedCreate: plan.plannedCreate, plannedUpdate: plan.plannedUpdate, plannedSkip: plan.plannedSkip },
  });
  if (count === 0) return false;
  await tx.migrationItem.deleteMany({ where: { runId: run.id } });
  for (let at = 0; at < plan.items.length; at += ITEM_INSERT_CHUNK) {
    await tx.migrationItem.createMany({ data: plan.items.slice(at, at + ITEM_INSERT_CHUNK).map((i) => ({ ...i, runId: run.id, tenantId: run.tenantId })) });
  }
  await announceRun(tx, run);
  return true;
}
