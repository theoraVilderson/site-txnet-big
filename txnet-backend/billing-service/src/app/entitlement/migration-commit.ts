import { Injectable, Logger } from '@nestjs/common';
import { FreezeMode, GrantSource, MigrationItemAction, MigrationItemOutcome, MigrationRunStatus, type MigrationItem, type MigrationRun, type Prisma } from '@prisma/client';
import { ResellerLimitReached, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { errorLine } from '../log-line';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigActionRefused } from '../traffic/config-actions';
import { GroupFulfilmentRefused, GroupFulfilmentService } from '../traffic/group-fulfilment';
import { freezeGrant } from './freeze';
import { EntitlementRefused, GrantService } from './grant';
import { planMigrationItem, sourceClientSchema } from './migration-plan';
import { claimRun, panelSourceOf, stillOurs } from './migration-preview';
import { announceRun, MIGRATION_ROLLBACK_DAYS } from './migration-run';
import { destroySourceLogin, ImportedPeople, MigrationSeamRefused, MigrationSeamUnavailable, SourceLoginVault, type ImportedPeopleAnswer } from './migration-seams';

/** Items committed per tick: identity's own batch (≤ 200, identity rule 2), each item one short transaction. */
export const MIGRATION_COMMIT_BATCH_SIZE = 200;
const DAY_MS = 86_400_000;

/** Why an item failed though nothing threw a reason of its own. */
const UNEXPECTED = 'unexpected';

/** The item itself cannot be issued now: its inbound lost its variant, or its end came since the preview. */
class ItemRefused extends Error {
  constructor(readonly reason: string) {
    super(`migration item refused: ${reason}`);
    this.name = 'ItemRefused';
  }
}
/** Read before the item's write and changed under it: another tick or a cancel. The item's transaction rolls back. */
class ItemMoved extends Error {}
/** The run is no longer this tick's (its lease lapsed and another took it). The batch stops. */
class RunLost extends Error {}

export type MigrationCommitResult = { outcome: 'none' | 'batch' | 'finished' | 'waiting' | 'lost'; items: number };

/** What one item became; `lost` stops the batch. */
type ItemResult = 'done' | 'failed' | 'moved' | 'lost';

type People = { made: Map<string, { userId: string; created: boolean }>; refused: Map<string, string> };
const peopleOf = (answer: ImportedPeopleAnswer): People => ({
  made: new Map(answer.users.map((u) => [u.remoteIdentity, { userId: u.userId, created: u.created }])),
  refused: new Map(answer.refused.map((r) => [r.remoteIdentity, r.reason])),
});

/** A refusal with a reason of its own, kept as the item's; anything else is `unexpected` and logged. */
function reasonOf(e: unknown): string | null {
  if (e instanceof ItemRefused || e instanceof EntitlementRefused || e instanceof ConfigActionRefused || e instanceof GroupFulfilmentRefused || e instanceof ResellerLimitReached) return e.reason;
  return null;
}

/** The name identity makes the username of (F-201-e): the label, else the source's id — as the plan names it. */
function labelOf(item: Pick<MigrationItem, 'remoteIdentity' | 'sourceSnapshot'>): string {
  const parsed = sourceClientSchema.safeParse(item.sourceSnapshot);
  if (!parsed.success) return item.remoteIdentity;
  return parsed.data.label.trim() || parsed.data.remoteId;
}

/**
 * The commit (F-207, entitlement `contract.import.md`): one `committing` run
 * per call, at most `MIGRATION_COMMIT_BATCH_SIZE` items, by `worker-service`'s
 * tick (ADR-0027).
 *
 * - **People first**, one identity batch: found or made by the source's key,
 *   so a retried batch makes no one twice. Who identity made is written on
 *   the item before anything else, so a rollback (F-211) removes only them.
 * - **One transaction per item**: a Grant of the inbound's variant with the
 *   source's end, bag and usage (`importedGrantShape`), placed by its group
 *   at once (`GroupFulfilmentService.fulfil`), frozen by an admin if the
 *   source had it switched off — its clock running, as it ran there.
 * - **A re-run never duplicates**: a key the tenant already holds a Grant of
 *   is `updated` and the Grant kept as it is (invariant 32).
 * - **A failed item is recorded and the batch goes on**; identity unreachable
 *   writes nothing and leaves the run to the next tick.
 *
 * When nothing is pending the run is `committed`, its rollback window open,
 * its source login destroyed. Every batch is told to the page (C-14).
 */
@Injectable()
export class MigrationCommitService {
  private readonly logger = new Logger(MigrationCommitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly people: ImportedPeople,
    private readonly grants: GrantService,
    private readonly fulfilment: GroupFulfilmentService,
    private readonly logins: SourceLoginVault,
  ) {}

  async commitNext(now: Date = new Date()): Promise<MigrationCommitResult> {
    const run = await claimRun(this.crossTenant, MigrationRunStatus.committing, now);
    if (!run) return { outcome: 'none', items: 0 };
    return runWithTenant({ id: run.tenantId }, () => this.commitBatch(run, now));
  }

  private async commitBatch(run: MigrationRun, now: Date): Promise<MigrationCommitResult> {
    const { batch, variantOf } = await tenantTransaction(this.prisma, async (tx) => {
      // A skip is the dry run's answer: nothing is issued for it, so it is recorded as it is reached.
      await tx.migrationItem.updateMany({ where: { runId: run.id, plannedAction: MigrationItemAction.skip, outcome: MigrationItemOutcome.pending }, data: { outcome: MigrationItemOutcome.skipped } });
      const [items, inbounds] = await Promise.all([
        tx.migrationItem.findMany({
          where: { runId: run.id, outcome: MigrationItemOutcome.pending, plannedAction: { not: MigrationItemAction.skip } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: MIGRATION_COMMIT_BATCH_SIZE,
        }),
        tx.migrationInbound.findMany({ where: { runId: run.id }, select: { inboundRemoteId: true, variantId: true } }),
      ]);
      return { batch: items, variantOf: new Map(inbounds.flatMap((i) => (i.variantId ? [[i.inboundRemoteId, i.variantId] as const] : []))) };
    });
    if (batch.length === 0) return this.finish(run, now);

    let people: People;
    try {
      people = peopleOf(await this.people.import(run.tenantId, batch.map((i) => ({ remoteIdentity: i.remoteIdentity, label: labelOf(i) }))));
    } catch (e) {
      if (!(e instanceof MigrationSeamUnavailable || e instanceof MigrationSeamRefused)) throw e;
      this.logger.warn(`run ${run.id}: people not imported, the next tick retries: ${errorLine(e)}`);
      await this.release(run, false);
      return { outcome: 'waiting', items: 0 };
    }
    await this.recordMadePeople(run, batch, people);

    let items = 0;
    for (const item of batch) {
      const result = await this.commitItem(run, item, people, variantOf, now);
      if (result === 'lost') return { outcome: 'lost', items };
      items += 1;
    }
    await this.release(run, true);
    this.logger.log(`run ${run.id}: committed a batch of ${items} item(s)`);
    return { outcome: 'batch', items };
  }

  /** Who identity made, on their items before any Grant: a crash after this still lets a rollback find them. */
  private recordMadePeople(run: MigrationRun, batch: MigrationItem[], people: People): Promise<void> {
    return tenantTransaction(this.prisma, async (tx) => {
      // One write per person made: the batch is at most `MIGRATION_COMMIT_BATCH_SIZE`.
      for (const item of batch) {
        const person = people.made.get(item.remoteIdentity);
        if (person?.created) await tx.migrationItem.updateMany({ where: { id: item.id, outcome: MigrationItemOutcome.pending }, data: { createdUserId: person.userId } });
      }
    });
  }

  private async commitItem(run: MigrationRun, item: MigrationItem, people: People, variantOf: ReadonlyMap<string, string>, now: Date): Promise<ItemResult> {
    const refused = people.refused.get(item.remoteIdentity);
    if (refused) return this.fail(run, item, refused);
    const person = people.made.get(item.remoteIdentity);
    if (!person) return this.fail(run, item, 'person_missing');
    try {
      await tenantTransaction(this.prisma, (tx) => this.issue(tx, run, item, person.userId, variantOf, now));
      return 'done';
    } catch (e) {
      if (e instanceof ItemMoved) return 'moved';
      if (e instanceof RunLost) return 'lost';
      const reason = reasonOf(e);
      if (reason === null) this.logger.error(`run ${run.id}: item ${item.id} failed: ${errorLine(e)}`);
      return this.fail(run, item, reason ?? UNEXPECTED);
    }
  }

  /** One item's write: the Grant kept, or a new one issued, placed and — switched off at the source — frozen. */
  private async issue(tx: Prisma.TransactionClient, run: MigrationRun, item: MigrationItem, userId: string, variantOf: ReadonlyMap<string, string>, now: Date): Promise<void> {
    const held = await tx.grant.findFirst({ where: { tenantId: run.tenantId, remoteIdentity: item.remoteIdentity }, select: { id: true } });
    if (held) return this.settle(tx, run, item, { outcome: MigrationItemOutcome.updated });

    const client = sourceClientSchema.parse(item.sourceSnapshot);
    const variantId = variantOf.get(client.inboundRemoteId);
    if (!variantId) throw new ItemRefused('inbound_unmapped');
    const plan = planMigrationItem(client, { ...panelSourceOf(run), variantId, now });
    // The snapshot is the preview's, but time passed: an end reached since is still an end.
    if (plan.skipReason) throw new ItemRefused(plan.skipReason);
    const { remoteIdentity, grant: planned } = plan;
    const { grant } = await this.grants.issue(tx, {
      userId,
      variantId,
      source: GrantSource.migration,
      sourceReferenceId: item.id,
      startsAt: now,
      imported: { remoteIdentity, endsAt: planned.endsAt, purchasedBytes: planned.purchasedBytes, consumedBytes: planned.consumedBytes, trafficUnlimited: planned.trafficUnlimited },
    });
    await this.place(tx, grant.id);
    if (!plan.enabled) await freezeGrant(tx, grant.id, { at: now, mode: FreezeMode.hard, stopsClock: false });
    const configs = await tx.config.findMany({ where: { grantId: grant.id }, select: { id: true } });
    await this.settle(tx, run, item, { outcome: MigrationItemOutcome.created, createdGrantId: grant.id, createdConfigIds: configs.map((c) => c.id) });
  }

  /** Placed now where its group can; a member that cannot take it yet is the sweep's (F-027-bl), never the item's failure. */
  private async place(tx: Prisma.TransactionClient, grantId: string): Promise<void> {
    try {
      await this.fulfilment.fulfil(tx, grantId);
    } catch (e) {
      if (!(e instanceof GroupFulfilmentRefused)) throw e;
      this.logger.warn(`grant ${grantId}: not placed at its import (${e.reason}); the fulfilment sweep places it`);
    }
  }

  /** The item's outcome and the run's count, both conditional: an item already done or a run lost rolls the write back. */
  private async settle(tx: Prisma.TransactionClient, run: MigrationRun, item: MigrationItem, data: Prisma.MigrationItemUpdateManyMutationInput): Promise<void> {
    const { count } = await tx.migrationItem.updateMany({ where: { id: item.id, outcome: MigrationItemOutcome.pending }, data });
    if (count === 0) throw new ItemMoved();
    const counted = await tx.migrationRun.updateMany({ where: stillOurs(run, MigrationRunStatus.committing), data: { committedItems: { increment: 1 } } });
    if (counted.count === 0) throw new RunLost();
  }

  /** A failed item, recorded in a transaction of its own (the item's rolled back): the batch goes on. */
  private async fail(run: MigrationRun, item: MigrationItem, reason: string): Promise<ItemResult> {
    return tenantTransaction(this.prisma, async (tx): Promise<ItemResult> => {
      const { count } = await tx.migrationItem.updateMany({ where: { id: item.id, outcome: MigrationItemOutcome.pending }, data: { outcome: MigrationItemOutcome.failed, failureReason: reason } });
      if (count === 0) return 'moved';
      const counted = await tx.migrationRun.updateMany({ where: stillOurs(run, MigrationRunStatus.committing), data: { failedItems: { increment: 1 } } });
      return counted.count === 0 ? 'lost' : 'failed';
    });
  }

  /** The lease goes back for the next tick; after a batch, the page is told. */
  private release(run: MigrationRun, announce: boolean): Promise<void> {
    return tenantTransaction(this.prisma, async (tx) => {
      const { count } = await tx.migrationRun.updateMany({ where: stillOurs(run, MigrationRunStatus.committing), data: { workerClaimedAt: null } });
      if (count === 1 && announce) await announceRun(tx, run);
    });
  }

  /** Nothing pending: committed, the rollback window open (D-63), the source login ended (tenant rule 5). */
  private async finish(run: MigrationRun, now: Date): Promise<MigrationCommitResult> {
    const finished = await tenantTransaction(this.prisma, async (tx) => {
      const { count } = await tx.migrationRun.updateMany({
        where: stillOurs(run, MigrationRunStatus.committing),
        data: { status: MigrationRunStatus.committed, rollbackUntil: new Date(now.getTime() + MIGRATION_ROLLBACK_DAYS * DAY_MS), workerClaimedAt: null },
      });
      if (count === 1) await announceRun(tx, run);
      return count === 1;
    });
    if (!finished) return { outcome: 'lost', items: 0 };
    await destroySourceLogin(this.logins, this.logger, run.tenantId, run.id);
    this.logger.log(`run ${run.id}: committed`);
    return { outcome: 'finished', items: 0 };
  }
}
