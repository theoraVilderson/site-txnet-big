import { Injectable, Logger } from '@nestjs/common';
import { GrantSource, MigrationItemAction, MigrationItemOutcome, MigrationRunKind, MigrationRunStatus, Prisma, VariantBillingMode, type MigrationRun } from '@prisma/client';
import {
  productCategoriesInclude,
  productCategoriesLive,
  ResellerAccess,
  tenantSellsProduct,
  tenantTransaction,
  type ResellerActor,
} from '@txnet-backend/shared-core';

import { GrantBulkPage } from '../payment/gift/grant-bulk-job.schema';
import { PrismaService } from '../prisma/prisma.service';
import { BALANCE_FILE_REFUSALS } from '../wallet/balance-import';
import { isDeliverableVariant } from './admin-issue';
import { assignable } from './grant';
import { admitMigration } from './migration-door';
import { TELEGRAM_CLAIMED } from './migration-plan';
import { announceRun, itemView, runView, type MigrationRunView } from './migration-run-view';
import { MigrationInbounds, MigrationRunCreate } from './migration-run.schema';
import { destroySourceLogin, SourceLoginVault } from './migration-seams';

/** Declared once (C-09): why a run's act was refused. */
export const MIGRATION_RUN_REJECTIONS = [
  'run_not_found',
  'run_busy',
  'run_closed',
  'run_not_previewed',
  'run_not_committed',
  'rollback_window_closed',
  'inbound_not_found',
  'variant_not_found',
  'variant_not_prepaid',
  'variant_not_deliverable',
  'variant_not_assignable',
  'legacy_host_not_routed',
  'legacy_link_not_found',
  /** A link run's person is not one of the tenant's (F-201-g). */
  'user_not_found',
  /** A link run committed before the admin chose its product (F-201-g). */
  'variant_unchosen',
  /** A balance file no row can be read from (F-209-a): no run is made. */
  ...BALANCE_FILE_REFUSALS,
] as const;
export type MigrationRunRejection = (typeof MIGRATION_RUN_REJECTIONS)[number];

export class MigrationRunRefused extends Error {
  constructor(
    readonly reason: MigrationRunRejection,
    detail = '',
  ) {
    super(`migration run refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'MigrationRunRefused';
  }
}

/** Days a committed run may be rolled back (D-63, F-211): `rollbackUntil` is set at its end. */
export const MIGRATION_ROLLBACK_DAYS = 7;

/** The statuses a run's mapping may change in; from `previewed` it is previewed again. */
const MAPPABLE: readonly MigrationRunStatus[] = [MigrationRunStatus.draft, MigrationRunStatus.previewed];
/** The statuses a run may still be cancelled from (`migration_run_status_moves`). */
const CANCELLABLE: readonly MigrationRunStatus[] = [MigrationRunStatus.draft, MigrationRunStatus.previewing, MigrationRunStatus.previewed];
/** A commit asked again once it started is answered as it is. */
const STARTED: readonly MigrationRunStatus[] = [MigrationRunStatus.committing, MigrationRunStatus.committed];
/** A rollback asked again once it started is answered as it is (F-211). */
const ROLLING: readonly MigrationRunStatus[] = [MigrationRunStatus.rolling_back, MigrationRunStatus.rolled_back];
/** Never committed, or not yet: nothing to roll back. A cancelled or expired run is `run_closed`. */
const UNCOMMITTED: readonly MigrationRunStatus[] = [MigrationRunStatus.draft, MigrationRunStatus.previewing, MigrationRunStatus.previewed, MigrationRunStatus.committing];

/**
 * A reseller's import from another panel (F-206, D-63, entitlement
 * `contract.import.md`): the run, its inbounds' variants, its dry run's
 * report. The door is `ResellerAccess` on `migration.manage` — `staffWrite`
 * to change a run, `read` to look — as the source login is (tenant
 * `contract.source-login.md` rule 2). Nothing here writes outside the run's
 * own tables (invariant 32); the snapshot and the plan are the worker's
 * (`MigrationPreviewService`).
 */
@Injectable()
export class MigrationRunService {
  private readonly logger = new Logger(MigrationRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
    private readonly logins: SourceLoginVault,
  ) {}

  create(actor: ResellerActor, tenantId: string, body: MigrationRunCreate): Promise<MigrationRunView> {
    return this.admitted(actor, tenantId, 'staffWrite', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const run = await tx.migrationRun.create({
          data: { tenantId, kind: MigrationRunKind.panel, sourceFamily: body.family, sourceAddress: body.sourceAddress, actorUserId: actor.userId },
        });
        return runView(run, []);
      }),
    );
  }

  /** The reseller's runs, newest first; their inbounds only on one run. */
  list(actor: ResellerActor, tenantId: string, page: Pick<GrantBulkPage, 'page' | 'pageSize'>) {
    const { page: p = 1, pageSize = 20 } = page;
    return this.admitted(actor, tenantId, 'read', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const [rows, total] = await Promise.all([
          tx.migrationRun.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, skip: (p - 1) * pageSize, take: pageSize }),
          tx.migrationRun.count({ where: { tenantId } }),
        ]);
        return { rows: rows.map((r) => runView(r)), page: p, pageSize, total };
      }),
    );
  }

  job(actor: ResellerActor, tenantId: string, runId: string): Promise<MigrationRunView> {
    return this.admitted(actor, tenantId, 'read', () => tenantTransaction(this.prisma, (tx) => this.viewOf(tx, tenantId, runId)));
  }

  /** The report's per-user table in the snapshot's order; `problems` keeps the skipped, the failed, what a rollback kept and a Telegram account not claimed (F-210). */
  outcomes(actor: ResellerActor, tenantId: string, runId: string, page: GrantBulkPage) {
    const { page: p = 1, pageSize = 20, problems } = page;
    return this.admitted(actor, tenantId, 'read', () =>
      tenantTransaction(this.prisma, async (tx) => {
        await this.find(tx, tenantId, runId);
        const where: Prisma.MigrationItemWhereInput = { runId, ...(problems ? { OR: [{ plannedAction: MigrationItemAction.skip }, { outcome: { in: [MigrationItemOutcome.failed, MigrationItemOutcome.kept] } }, { telegramLink: { not: TELEGRAM_CLAIMED } }] } : {}) };
        const [items, total] = await Promise.all([
          // A report is written in one transaction, so its rows share `createdAt`: the key orders them (a csv run's is its line, F-209-a).
          tx.migrationItem.findMany({ where, orderBy: [{ createdAt: 'asc' }, { remoteIdentity: 'asc' }], skip: (p - 1) * pageSize, take: pageSize }),
          tx.migrationItem.count({ where }),
        ]);
        return { rows: items.map(itemView), page: p, pageSize, total };
      }),
    );
  }

  /**
   * The reseller's choice for each source inbound (F-206): one of its prepaid
   * variants, or none. A variant is held to what an admin may hand out by
   * hand (F-311-o) and to prepaid: an import brings a bag and an end, never a
   * meter. A previewed run's mapping changed is previewed again.
   */
  setInbounds(actor: ResellerActor, tenantId: string, runId: string, body: MigrationInbounds): Promise<MigrationRunView> {
    return this.admitted(actor, tenantId, 'staffWrite', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const run = await this.find(tx, tenantId, runId);
        assertMappable(run);
        const known = await tx.migrationInbound.findMany({ where: { runId }, select: { inboundRemoteId: true } });
        const ids = new Set(known.map((i) => i.inboundRemoteId));
        for (const choice of body.inbounds) {
          if (!ids.has(choice.inboundRemoteId)) throw new MigrationRunRefused('inbound_not_found', choice.inboundRemoteId);
          if (choice.variantId) await assertImportVariant(tx, tenantId, choice.variantId);
          await tx.migrationInbound.update({ where: { runId_inboundRemoteId: { runId, inboundRemoteId: choice.inboundRemoteId } }, data: { variantId: choice.variantId } });
        }
        if (run.status === MigrationRunStatus.previewed) await this.startPreview(tx, run);
        return this.viewOf(tx, tenantId, runId);
      }),
    );
  }

  /** Starts the dry run: the worker reads the source and writes the report. Asked again while it runs, answered as it is. */
  preview(actor: ResellerActor, tenantId: string, runId: string): Promise<MigrationRunView> {
    return this.admitted(actor, tenantId, 'staffWrite', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const run = await this.find(tx, tenantId, runId);
        if (run.status !== MigrationRunStatus.previewing) {
          assertMappable(run);
          await this.startPreview(tx, run);
        }
        return this.viewOf(tx, tenantId, runId);
      }),
    );
  }

  /** Ends a run before its commit; its source login is destroyed with it (tenant rule 5). A cancelled run is answered as it is. */
  async cancel(actor: ResellerActor, tenantId: string, runId: string): Promise<MigrationRunView> {
    const view = await this.admitted(actor, tenantId, 'staffWrite', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const run = await this.find(tx, tenantId, runId);
        if (run.status === MigrationRunStatus.cancelled) return runView(run);
        if (!CANCELLABLE.includes(run.status)) throw new MigrationRunRefused('run_closed', run.status);
        const after = await tx.migrationRun.update({ where: { id: run.id }, data: { status: MigrationRunStatus.cancelled, workerClaimedAt: null } });
        await announceRun(tx, after);
        return runView(after);
      }),
    );
    // A link run never had a login (F-201-g).
    if (view.kind === MigrationRunKind.panel) await destroySourceLogin(this.logins, this.logger, tenantId, runId);
    return view;
  }

  /**
   * The reseller confirms the report (F-207): the worker issues what it
   * planned, a batch a tick (`MigrationCommitService`). From here the source
   * is not read again and its login ends (tenant rule 5). Asked again once
   * started, answered as it is; a run never previewed is `run_not_previewed`.
   */
  commit(actor: ResellerActor, tenantId: string, runId: string): Promise<MigrationRunView> {
    return this.admitted(actor, tenantId, 'staffWrite', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const run = await this.find(tx, tenantId, runId);
        if (STARTED.includes(run.status)) return runView(run);
        if (run.status === MigrationRunStatus.draft || run.status === MigrationRunStatus.previewing) throw new MigrationRunRefused('run_not_previewed', run.status);
        if (run.status !== MigrationRunStatus.previewed) throw new MigrationRunRefused('run_closed', run.status);
        // A link run has no inbounds to map: its one client becomes the product the admin chose (F-201-g).
        if (run.kind === MigrationRunKind.link && !run.variantId) throw new MigrationRunRefused('variant_unchosen', run.id);
        const after = await tx.migrationRun.update({ where: { id: run.id }, data: { status: MigrationRunStatus.committing, workerClaimedAt: null } });
        await announceRun(tx, after);
        return runView(after);
      }),
    );
  }

  /**
   * The reseller undoes a committed run inside its window (F-211, D-63): the
   * worker rolls it back a batch a tick (`MigrationRollbackService`). Asked
   * again once started, answered as it is; past `rollbackUntil` it is
   * `rollback_window_closed` — the snapshots it would be judged by are gone.
   */
  rollback(actor: ResellerActor, tenantId: string, runId: string, now: Date = new Date()): Promise<MigrationRunView> {
    return this.admitted(actor, tenantId, 'staffWrite', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const run = await this.find(tx, tenantId, runId);
        if (ROLLING.includes(run.status)) return runView(run);
        if (UNCOMMITTED.includes(run.status)) throw new MigrationRunRefused('run_not_committed', run.status);
        if (run.status !== MigrationRunStatus.committed) throw new MigrationRunRefused('run_closed', run.status);
        if (!run.rollbackUntil || run.rollbackUntil.getTime() <= now.getTime()) throw new MigrationRunRefused('rollback_window_closed', run.rollbackUntil?.toISOString());
        const after = await tx.migrationRun.update({ where: { id: run.id }, data: { status: MigrationRunStatus.rolling_back, rollbackActorUserId: actor.userId, workerClaimedAt: null } });
        await announceRun(tx, after);
        return runView(after);
      }),
    );
  }

  private async startPreview(tx: Prisma.TransactionClient, run: MigrationRun): Promise<void> {
    const after = await tx.migrationRun.update({ where: { id: run.id }, data: { status: MigrationRunStatus.previewing, failureReason: null, workerClaimedAt: null } });
    await announceRun(tx, after);
  }

  private async viewOf(tx: Prisma.TransactionClient, tenantId: string, runId: string): Promise<MigrationRunView> {
    const run = await this.find(tx, tenantId, runId);
    const inbounds = await tx.migrationInbound.findMany({ where: { runId }, orderBy: { inboundRemoteId: 'asc' } });
    return runView(run, inbounds);
  }

  /** The run, only if it is this reseller's: the query says the tenant (C-15), as RLS does. */
  private async find(tx: Prisma.TransactionClient, tenantId: string, runId: string): Promise<MigrationRun> {
    const run = await tx.migrationRun.findFirst({ where: { id: runId, tenantId } });
    if (!run) throw new MigrationRunRefused('run_not_found', runId);
    return run;
  }

  private admitted<T>(actor: ResellerActor, tenantId: string, capability: 'read' | 'staffWrite', work: () => Promise<T>): Promise<T> {
    return admitMigration(this.access, { actor, tenantId, capability }, work);
  }
}


function assertMappable(run: MigrationRun): void {
  if (run.status === MigrationRunStatus.previewing) throw new MigrationRunRefused('run_busy', run.status);
  if (!MAPPABLE.includes(run.status)) throw new MigrationRunRefused('run_closed', run.status);
}

/**
 * A variant an inbound may be mapped to: the reseller's own or a platform
 * product its package lists (F-019-v5), live, prepaid and deliverable — what
 * `issueGrantByAdmin` would hand out (F-311-o), so the commit issues nothing
 * a sale would refuse.
 */
export async function assertImportVariant(tx: Prisma.TransactionClient, tenantId: string, variantId: string): Promise<void> {
  const variant = await tx.productVariant.findUnique({
    where: { id: variantId },
    select: {
      isActive: true,
      visibility: true,
      panelGroupId: true,
      billingMode: true,
      quotas: true,
      product: { select: { id: true, tenantId: true, isActive: true, fulfilmentKind: true, ...productCategoriesInclude } },
    },
  });
  if (!variant || !(await tenantSellsProduct(tx, tenantId, variant.product))) throw new MigrationRunRefused('variant_not_found', variantId);
  if (variant.billingMode !== VariantBillingMode.prepaid) throw new MigrationRunRefused('variant_not_prepaid', variantId);
  const facts = { visibility: variant.visibility, isActive: variant.isActive, productActive: variant.product.isActive, categoryActive: productCategoriesLive(variant.product.categories) };
  if (!assignable(GrantSource.migration, facts)) throw new MigrationRunRefused('variant_not_assignable', variantId);
  if (!(await isDeliverableVariant(tx, variant))) throw new MigrationRunRefused('variant_not_deliverable', variantId);
}
