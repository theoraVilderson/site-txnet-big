import { Injectable, type Logger } from '@nestjs/common';
import { MigrationRunKind, MigrationRunStatus, type MigrationItem, type MigrationRun, type Prisma } from '@prisma/client';
import { ResellerAccess, tenantTransaction, type ResellerActor } from '@txnet-backend/shared-core';

import { trafficQuotaOf } from '../catalog/traffic-quota';
import { errorLine } from '../log-line';
import { PrismaService } from '../prisma/prisma.service';
import { legacyPathOf } from './legacy-sub-link';
import { linkClientOf, linkIdentityOf, linkItemClientOf, planLinkRun } from './migration-link';
import { sourceClientSchema, type SourceClient } from './migration-plan';
import { admitMigration } from './migration-door';
import { assertImportVariant, MigrationRunRefused } from './migration-run';
import { announceRun, runView, type MigrationRunView } from './migration-run-view';
import type { MigrationLinkCorrection, MigrationLinkRunCreate } from './migration-run.schema';
import { MigrationSeamRefused, type SubscriptionLinkProbe } from './migration-seams';
import type { RunPlan } from './migration-run-plan';

/** The link could not be asked at all (network-service unset or down); retried by previewing again. */
const LINK_UNREACHABLE = 'source_unavailable';
/** The link answered figures no client can hold (an end past any date); nothing to import from it. */
const LINK_UNREADABLE = 'source_unreadable';

/** A link run's old link; `migration_run_source_fits_kind` holds it on every link run, so a missing one is a broken row. */
export function linkOf(run: Pick<MigrationRun, 'id' | 'sourceAddress'>): string {
  if (!run.sourceAddress) throw new Error(`run ${run.id} names no link`);
  return run.sourceAddress;
}

/**
 * Reads a link run's old link through network-service (F-201-g): its client,
 * or why the preview goes back to `draft` — network's refusal
 * (`address_refused`, `source_redirected`, …) or `source_unavailable`.
 */
export async function readLinkRun(probe: Pick<SubscriptionLinkProbe, 'read'>, run: MigrationRun, logger: Logger): Promise<{ client: SourceClient } | { reason: string }> {
  try {
    return { client: linkClientOf(linkOf(run), await probe.read(linkOf(run))) };
  } catch (e) {
    const reason = e instanceof MigrationSeamRefused ? e.reason : e instanceof RangeError ? LINK_UNREADABLE : LINK_UNREACHABLE;
    logger.warn(`run ${run.id}: link not read (${reason}): ${errorLine(e)}`);
    return { reason };
  }
}

/**
 * A link run's report against what the tenant holds now (F-201-g): a Grant of
 * the link's key already, its old path answering for another Grant, and the
 * chosen product's traffic. `client` is the corrected one; `read` what the
 * link said, kept as the item's snapshot.
 */
export async function linkPlanOf(tx: Prisma.TransactionClient, run: MigrationRun, at: { client: SourceClient; read: SourceClient; now: Date }): Promise<RunPlan> {
  const link = linkOf(run);
  const key = linkIdentityOf(link);
  const oldPath = legacyPathOf(link);
  const [held, taken, variant] = await Promise.all([
    tx.grant.findFirst({ where: { tenantId: run.tenantId, remoteIdentity: key }, select: { id: true } }),
    oldPath ? tx.legacySubLink.findFirst({ where: { tenantId: run.tenantId, host: oldPath.host, path: oldPath.path }, select: { id: true } }) : null,
    run.variantId ? tx.productVariant.findUnique({ where: { id: run.variantId }, select: { quotas: true } }) : null,
  ]);
  const variantUnlimited = variant ? trafficQuotaOf(variant.quotas).kind === 'unlimited' : null;
  return planLinkRun(at.client, key, { now: at.now, variantUnlimited, held: held !== null, oldLinkTaken: taken !== null }, at.read);
}

/** A field the correction did not name keeps its value; null clears it. */
const kept = <T>(given: T | undefined, current: T): T => (given === undefined ? current : given);

/**
 * One user's import from an old link (F-201-g, D-63, entitlement
 * `contract.link-import.md`), on the whole-panel engine: a `link` run for a
 * person of the tenant, read by the worker's dry run, corrected and given a
 * product by an admin, then committed and rolled back as any run. The door is
 * the import's: `migration.manage`, `staffWrite`.
 */
@Injectable()
export class MigrationLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
  ) {}

  /** A link run for one person of the tenant, its dry run started at once: a link needs no login (network rule: the link is the user's own). */
  create(actor: ResellerActor, tenantId: string, body: MigrationLinkRunCreate): Promise<MigrationRunView> {
    return admitMigration(this.access, { actor, tenantId, capability: 'staffWrite' }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const person = await tx.user.findFirst({ where: { id: body.userId, tenantId }, select: { id: true } });
        if (!person) throw new MigrationRunRefused('user_not_found', body.userId);
        return runView(await startLinkRun(tx, { tenantId, link: body.url, userId: body.userId, actorUserId: actor.userId }));
      }),
    );
  }

  /**
   * The admin's word over what the link said (F-201-g): the product, the
   * quota, the usage, the end — each left as it is when not named, cleared by
   * null. Only on a previewed run: the item is re-planned at once (no new read
   * of the link), the snapshot untouched.
   */
  correct(actor: ResellerActor, tenantId: string, runId: string, body: MigrationLinkCorrection, now: Date = new Date()): Promise<MigrationRunView> {
    return admitMigration(this.access, { actor, tenantId, capability: 'staffWrite' }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const run = await tx.migrationRun.findFirst({ where: { id: runId, tenantId, kind: MigrationRunKind.link } });
        if (!run) throw new MigrationRunRefused('run_not_found', runId);
        if (run.status === MigrationRunStatus.previewing) throw new MigrationRunRefused('run_busy', run.status);
        if (run.status !== MigrationRunStatus.previewed) throw new MigrationRunRefused('run_closed', run.status);
        if (body.variantId) await assertImportVariant(tx, tenantId, body.variantId);
        const item = await tx.migrationItem.findFirstOrThrow({ where: { runId } });
        const after = await tx.migrationRun.update({ where: { id: run.id }, data: { variantId: kept(body.variantId, run.variantId) } });
        const corrected = await tx.migrationItem.update({ where: { id: item.id }, data: correctionData(body, item) });
        await replan(tx, after, corrected, now);
        await announceRun(tx, after);
        return runView(await tx.migrationRun.findUniqueOrThrow({ where: { id: run.id } }));
      }),
    );
  }
}

/** A link run, created in `previewing` so the worker's next tick reads the link (F-201-g). */
export async function startLinkRun(tx: Prisma.TransactionClient, at: { tenantId: string; link: string; userId: string; actorUserId: string }): Promise<MigrationRun> {
  const run = await tx.migrationRun.create({
    data: { tenantId: at.tenantId, kind: MigrationRunKind.link, sourceAddress: at.link, userId: at.userId, actorUserId: at.actorUserId, status: MigrationRunStatus.previewing },
  });
  await announceRun(tx, run);
  return run;
}

function correctionData(body: MigrationLinkCorrection, item: MigrationItem): Prisma.MigrationItemUpdateInput {
  const bytes = (v: number | null | undefined, current: bigint | null) => (v === undefined ? current : v === null ? null : BigInt(v));
  return {
    correctedDataLimitBytes: bytes(body.dataLimitBytes, item.correctedDataLimitBytes),
    correctedUsedBytes: bytes(body.usedBytes, item.correctedUsedBytes),
    correctedExpiresAt: kept(body.expiresAt, item.correctedExpiresAt),
  };
}

/** The one item planned again from its corrected client, and the run's counts with it. */
async function replan(tx: Prisma.TransactionClient, run: MigrationRun, item: MigrationItem, now: Date): Promise<void> {
  const plan = await linkPlanOf(tx, run, { client: linkItemClientOf(item), read: sourceClientSchema.parse(item.sourceSnapshot), now });
  const [planned] = plan.items;
  await tx.migrationItem.update({ where: { id: item.id }, data: { plannedAction: planned.plannedAction, skipReason: planned.skipReason } });
  await tx.migrationRun.update({ where: { id: run.id }, data: { plannedCreate: plan.plannedCreate, plannedUpdate: plan.plannedUpdate, plannedSkip: plan.plannedSkip } });
}
