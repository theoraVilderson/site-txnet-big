import { Injectable, Logger } from '@nestjs/common';
import { GrantSource, GrantStatus, MigrationItemOutcome, MigrationRunStatus, Prisma, QuotaMetric, WalletReasonType, type Grant, type MigrationItem, type MigrationRun } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { errorLine } from '../log-line';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { RemainderCreditService } from '../traffic/remainder-credit';
import { UsageSettlementService } from '../usage/usage-settlement';
import { deleteGrant } from './delete';
import { removeLegacyLinks } from './legacy-sub-link';
import { EntitlementRefused } from './grant';
import { MIGRATION_COMMIT_BATCH_SIZE } from './migration-commit';
import { claimRun, stillOurs } from './migration-preview';
import { announceRun } from './migration-run';
import { ImportedPeople, MigrationSeamRefused, MigrationSeamUnavailable } from './migration-seams';

/** `grant.statusReason` and the `grant_deletion` reason of a Grant an import's rollback closed (F-211). */
export const MIGRATION_ROLLED_BACK = 'migration_rolled_back';

/** Items undone per tick: the commit's batch, so the people are one identity call (≤ 200, identity rule 2). */
const ROLLBACK_BATCH_SIZE = MIGRATION_COMMIT_BATCH_SIZE;
/** Runs whose window ended, purged per tick: each is one update of its items. */
const PURGE_RUNS_PER_TICK = 10;
/** Why an item was kept though nothing refused it by name; logged. */
const UNEXPECTED = 'unexpected';

/** A customer buys a Grant of these; a trial or an admin's gift is not the customer's act. */
const BOUGHT_SOURCES: GrantSource[] = [GrantSource.purchase, GrantSource.coupon];
/** Wallet rows that are the customer paying: money in by a gateway, a product bought from the wallet. */
const PAID_REASONS: WalletReasonType[] = [WalletReasonType.payment_gateway, WalletReasonType.product_purchase];
/** Already off: nothing to close, and its configs are the purge's. */
const CLOSED: GrantStatus[] = [GrantStatus.expired, GrantStatus.exhausted, GrantStatus.cancelled];

/** Why the rollback keeps an item: its customer has lived here since the import (F-211). */
export type KeptReason = 'renewed' | 'topped_up' | 'bought';
/** Why a person the run made stays though its Grant was undone, on billing's side. */
type HeldReason = 'holds_other_service' | 'paid';

type ImportedGrant = Pick<Grant, 'id' | 'userId' | 'status' | 'startsAt' | 'endSetAt' | 'createdAt'>;
const IMPORTED_GRANT = { id: true, userId: true, status: true, startsAt: true, endSetAt: true, createdAt: true } as const;

/** What the tenant did with a batch's Grants since they were imported. */
export type LivedSince = { renewed: ReadonlySet<string>; toppedUp: ReadonlySet<string>; boughtAt: ReadonlyMap<string, Date>; paidAt: ReadonlyMap<string, Date> };

/**
 * Whether an imported Grant has lived here since (F-211): an end moved after
 * the import — a renewal on any path, or an admin's days — a renewal row,
 * bytes added, or its customer buying or paying after it was imported.
 * Anything before the import is the person's own history, not the run's.
 */
export function keptReasonOf(grant: ImportedGrant, lived: LivedSince): KeptReason | null {
  if (lived.renewed.has(grant.id) || (grant.endSetAt !== null && grant.endSetAt.getTime() > grant.startsAt.getTime())) return 'renewed';
  if (lived.toppedUp.has(grant.id)) return 'topped_up';
  const since = (at: Date | undefined) => at !== undefined && at.getTime() > grant.createdAt.getTime();
  if (since(lived.boughtAt.get(grant.userId)) || since(lived.paidAt.get(grant.userId))) return 'bought';
  return null;
}

/** Each user's wallet rows of `reasons` (all of them when unset), latest first: one query for the wallets, one grouped. */
async function walletActivity(tx: Prisma.TransactionClient, userIds: string[], reasons?: WalletReasonType[]): Promise<Map<string, Date>> {
  const wallets = await tx.wallet.findMany({ where: { ownerUserId: { in: userIds } }, select: { id: true, ownerUserId: true } });
  if (wallets.length === 0) return new Map();
  const ownerOf = new Map(wallets.map((w) => [w.id, w.ownerUserId]));
  const rows = await tx.walletTransaction.groupBy({ by: ['walletId'], where: { walletId: { in: [...ownerOf.keys()] }, ...(reasons ? { reasonType: { in: reasons } } : {}) }, _max: { createdAt: true } });
  return new Map(rows.flatMap((r) => (r._max.createdAt ? [[ownerOf.get(r.walletId) ?? r.walletId, r._max.createdAt] as const] : [])));
}

/** The facts `keptReasonOf` reads, for a whole batch: a handful of queries, never one per item (C-28). */
async function livedSince(tx: Prisma.TransactionClient, grants: ImportedGrant[]): Promise<LivedSince> {
  const ids = grants.map((g) => g.id);
  const users = [...new Set(grants.map((g) => g.userId))];
  const [renewals, topUps, purchases, paidAt] = await Promise.all([
    tx.grantRenewal.findMany({ where: { grantId: { in: ids } }, select: { grantId: true }, distinct: ['grantId'] }),
    tx.quotaAdjustment.findMany({ where: { grantId: { in: ids }, metric: QuotaMetric.traffic_bytes }, select: { grantId: true }, distinct: ['grantId'] }),
    tx.grant.groupBy({ by: ['userId'], where: { userId: { in: users }, source: { in: BOUGHT_SOURCES } }, _max: { createdAt: true } }),
    walletActivity(tx, users, PAID_REASONS),
  ]);
  return {
    renewed: new Set(renewals.map((r) => r.grantId)),
    toppedUp: new Set(topUps.map((r) => r.grantId)),
    boughtAt: new Map(purchases.flatMap((p) => (p._max.createdAt ? [[p.userId, p._max.createdAt] as const] : []))),
    paidAt,
  };
}

type Person = { item: MigrationItem; userId: string };

/** People the run made who hold anything here but the Grant it undid: another service, or any money moved. */
async function heldByBilling(tx: Prisma.TransactionClient, people: Person[]): Promise<Map<string, HeldReason>> {
  const users = people.map((p) => p.userId);
  const own = people.flatMap((p) => (p.item.createdGrantId ? [p.item.createdGrantId] : []));
  const [others, moved] = await Promise.all([
    tx.grant.groupBy({ by: ['userId'], where: { userId: { in: users }, id: { notIn: own } }, _count: { _all: true } }),
    walletActivity(tx, users),
  ]);
  const held = new Map<string, HeldReason>([...moved.keys()].map((u) => [u, 'paid']));
  for (const o of others) held.set(o.userId, 'holds_other_service');
  return held;
}

export type MigrationRollbackResult = { outcome: 'none' | 'batch' | 'finished' | 'waiting' | 'lost'; items: number };

/** Read before the item's write and changed under it: another tick. The item's transaction rolls back. */
class ItemMoved extends Error {}

/**
 * An import's rollback (F-211, entitlement `contract.import.md`): one
 * `rolling_back` run per call, at most `ROLLBACK_BATCH_SIZE` items, by
 * `worker-service`'s tick (ADR-0027), as the commit did it.
 *
 * - **A customer who lived here since is kept** (`keptReasonOf`): the item is
 *   `kept` with why, its Grant and person untouched.
 * - **Otherwise its Grant is closed as an admin's delete answering no**
 *   (`deleteGrant`, `migration_rolled_back`): its configs released now, no
 *   remainder to the user — nothing was paid here — every other meter
 *   settled, and the reseller's wholesale given back.
 * - **A person the run made is removed by identity** unless they hold
 *   something else here or did something there; why one stays is listed.
 *   Identity unreachable leaves those items for the next tick — their Grants
 *   are closed once, the item's write guards it.
 *
 * When nothing is left the run is `rolled_back`. Every batch is told (C-14).
 */
@Injectable()
export class MigrationRollbackService {
  private readonly logger = new Logger(MigrationRollbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly people: ImportedPeople,
    private readonly remainders: RemainderCreditService,
    private readonly meters: UsageSettlementService,
  ) {}

  async rollbackNext(now: Date = new Date()): Promise<MigrationRollbackResult> {
    const run = await claimRun(this.crossTenant, MigrationRunStatus.rolling_back, now);
    if (!run) return { outcome: 'none', items: 0 };
    return runWithTenant({ id: run.tenantId }, () => this.rollbackBatch(run, now));
  }

  /**
   * The snapshots of every run whose window ended (D-63: the source state is
   * kept for the rollback, and only while one may come), a few runs a tick.
   */
  async purgeEnded(now: Date = new Date()): Promise<number> {
    const runs = await this.crossTenant.migrationRun.findMany({
      where: { status: { in: [MigrationRunStatus.committed, MigrationRunStatus.rolled_back] }, rollbackUntil: { lte: now }, snapshotsPurgedAt: null },
      select: { id: true, tenantId: true, actorUserId: true },
      orderBy: { rollbackUntil: 'asc' },
      take: PURGE_RUNS_PER_TICK,
    });
    let purged = 0;
    for (const run of runs) {
      const done = await runWithTenant({ id: run.tenantId }, () =>
        tenantTransaction(this.prisma, async (tx) => {
          const { count } = await tx.migrationRun.updateMany({ where: { id: run.id, snapshotsPurgedAt: null }, data: { snapshotsPurgedAt: now } });
          if (count === 0) return false;
          await tx.migrationItem.updateMany({ where: { runId: run.id }, data: { sourceSnapshot: Prisma.DbNull } });
          await announceRun(tx, run);
          return true;
        }),
      );
      if (done) purged += 1;
    }
    if (purged > 0) this.logger.log(`purged the source snapshots of ${purged} run(s) whose rollback window ended`);
    return purged;
  }

  private async rollbackBatch(run: MigrationRun, now: Date): Promise<MigrationRollbackResult> {
    const { batch, grants, lived } = await tenantTransaction(this.prisma, async (tx) => {
      // An item the commit created, or one whose person the run made: an `updated` item's Grant is an earlier run's.
      const items = await tx.migrationItem.findMany({
        where: { runId: run.id, rolledBackAt: null, OR: [{ outcome: MigrationItemOutcome.created }, { createdUserId: { not: null } }] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: ROLLBACK_BATCH_SIZE,
      });
      const ids = items.flatMap((i) => (i.outcome === MigrationItemOutcome.created && i.createdGrantId ? [i.createdGrantId] : []));
      const found = ids.length > 0 ? await tx.grant.findMany({ where: { id: { in: ids } }, select: IMPORTED_GRANT }) : [];
      return { batch: items, grants: new Map(found.map((g) => [g.id, g])), lived: await livedSince(tx, found) };
    });
    if (batch.length === 0) return this.finish(run, now);

    const people: Person[] = [];
    for (const item of batch) {
      const undone = item.outcome !== MigrationItemOutcome.created || (await this.undoItem(run, item, grants, lived, now));
      if (undone && item.createdUserId) people.push({ item, userId: item.createdUserId });
    }
    const settled = await this.removePeople(run, people, now);
    await this.release(run);
    this.logger.log(`run ${run.id}: rolled back a batch of ${batch.length} item(s)${settled ? '' : '; its people wait for identity'}`);
    return { outcome: settled ? 'batch' : 'waiting', items: batch.length };
  }

  /** One item in its own transaction: kept with why, or its Grant closed. True when its person is next. */
  private async undoItem(run: MigrationRun, item: MigrationItem, grants: ReadonlyMap<string, ImportedGrant>, lived: LivedSince, now: Date): Promise<boolean> {
    const grant = item.createdGrantId ? grants.get(item.createdGrantId) : undefined;
    const kept = grant ? keptReasonOf(grant, lived) : null;
    if (kept) return this.keep(item, kept, now);
    try {
      await tenantTransaction(this.prisma, async (tx) => {
        if (grant && !CLOSED.includes(grant.status)) await this.close(tx, run, grant.id, now);
        // A person the run made is removed after the batch; the item is done with only then.
        const { count } = await tx.migrationItem.updateMany({
          where: { id: item.id, outcome: MigrationItemOutcome.created },
          data: { outcome: MigrationItemOutcome.rolled_back, rolledBackAt: item.createdUserId ? null : now },
        });
        if (count === 0) throw new ItemMoved();
      });
      return true;
    } catch (e) {
      // Another tick, or a Grant moved under the close: the next tick reads it again.
      if (e instanceof ItemMoved || (e instanceof EntitlementRefused && e.reason === 'grant_moved')) return false;
      const reason = e instanceof EntitlementRefused ? e.reason : UNEXPECTED;
      if (reason === UNEXPECTED) this.logger.error(`run ${run.id}: item ${item.id} not rolled back: ${errorLine(e)}`);
      return this.keep(item, reason, now);
    }
  }

  /** The item stays as the commit left it, listed with why. Never its person's turn. */
  private async keep(item: MigrationItem, reason: string, now: Date): Promise<false> {
    await tenantTransaction(this.prisma, (tx) =>
      tx.migrationItem.updateMany({ where: { id: item.id, outcome: MigrationItemOutcome.created }, data: { outcome: MigrationItemOutcome.kept, keptReason: reason, rolledBackAt: now } }),
    );
    return false;
  }

  /** The admin delete's close with the remainder answered no (F-311-m): every meter settles, the wholesale comes back, the old link stops (F-203-a). */
  private async close(tx: Prisma.TransactionClient, run: MigrationRun, grantId: string, now: Date): Promise<void> {
    const actorUserId = run.rollbackActorUserId ?? run.actorUserId;
    await deleteGrant(tx, grantId, { at: now, actorUserId, reason: MIGRATION_ROLLED_BACK, refund: false, statusReason: MIGRATION_ROLLED_BACK }, (t, id, clock) => this.remainders.settle(t, { grantId: id, ...clock }));
    await removeLegacyLinks(tx, grantId);
    await this.meters.settleAtClose(tx, { grantId, refund: false });
    await this.remainders.wholesaleAtClose(tx, grantId);
  }

  /**
   * The people the batch's undone items made: billing keeps who holds
   * something else here, identity removes the rest or says why not. False
   * when identity could not be asked; those items wait for the next tick.
   */
  private async removePeople(run: MigrationRun, people: Person[], now: Date): Promise<boolean> {
    if (people.length === 0) return true;
    const held = await tenantTransaction(this.prisma, (tx) => heldByBilling(tx, people));
    const asked = people.filter((p) => !held.has(p.userId)).map((p) => p.userId);
    let kept = new Map<string, string>();
    if (asked.length > 0) {
      try {
        const answer = await this.people.remove(run.tenantId, asked);
        kept = new Map(answer.kept.map((k) => [k.userId, k.reason]));
      } catch (e) {
        if (!(e instanceof MigrationSeamUnavailable || e instanceof MigrationSeamRefused)) throw e;
        this.logger.warn(`run ${run.id}: people not removed, the next tick retries: ${errorLine(e)}`);
        return false;
      }
    }
    await tenantTransaction(this.prisma, async (tx) => {
      // One write per person: the batch is at most `ROLLBACK_BATCH_SIZE`.
      for (const p of people) {
        await tx.migrationItem.updateMany({ where: { id: p.item.id, rolledBackAt: null }, data: { rolledBackAt: now, keptReason: held.get(p.userId) ?? kept.get(p.userId) ?? null } });
      }
    });
    return true;
  }

  /** The lease goes back for the next tick, and the page is told: Grants were closed whether or not identity answered. */
  private release(run: MigrationRun): Promise<void> {
    return tenantTransaction(this.prisma, async (tx) => {
      const { count } = await tx.migrationRun.updateMany({ where: stillOurs(run, MigrationRunStatus.rolling_back), data: { workerClaimedAt: null } });
      if (count === 1) await announceRun(tx, run);
    });
  }

  private async finish(run: MigrationRun, now: Date): Promise<MigrationRollbackResult> {
    const finished = await tenantTransaction(this.prisma, async (tx) => {
      const { count } = await tx.migrationRun.updateMany({ where: stillOurs(run, MigrationRunStatus.rolling_back), data: { status: MigrationRunStatus.rolled_back, workerClaimedAt: null } });
      if (count === 1) await announceRun(tx, run);
      return count === 1;
    });
    if (!finished) return { outcome: 'lost', items: 0 };
    this.logger.log(`run ${run.id}: rolled back at ${now.toISOString()}`);
    return { outcome: 'finished', items: 0 };
  }
}
