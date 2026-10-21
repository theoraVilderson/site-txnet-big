import { Injectable, Logger } from '@nestjs/common';
import { GrantSource, MigrationItemAction, MigrationItemOutcome, MigrationRunKind, MigrationRunStatus, Prisma, VariantBillingMode, type MigrationInbound, type MigrationRun } from '@prisma/client';
import {
  OutboxEventType,
  productCategoriesInclude,
  productCategoriesLive,
  ResellerAccess,
  ResellerAccessRefused,
  tenantSellsProduct,
  tenantTransaction,
  type ResellerActor,
} from '@txnet-backend/shared-core';

import { errorLine } from '../log-line';
import { GrantBulkPage } from '../payment/gift/grant-bulk-job.schema';
import { ResellerUserGrantsRefused } from '../payment/gift/reseller-user-grants.service';
import { PrismaService } from '../prisma/prisma.service';
import { isDeliverableVariant } from './admin-issue';
import { assignable } from './grant';
import { MigrationInbounds, MigrationRunCreate } from './migration-run.schema';
import { SourceLoginVault } from './migration-seams';

/** Declared once (C-09): why a run's act was refused. */
export const MIGRATION_RUN_REJECTIONS = [
  'run_not_found',
  'run_busy',
  'run_closed',
  'run_not_previewed',
  'inbound_not_found',
  'variant_not_found',
  'variant_not_prepaid',
  'variant_not_deliverable',
  'variant_not_assignable',
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

/** The statuses a run's mapping may change in; from `previewed` it is previewed again. */
const MAPPABLE: readonly MigrationRunStatus[] = [MigrationRunStatus.draft, MigrationRunStatus.previewed];
/** The statuses a run may still be cancelled from (`migration_run_status_moves`). */
const CANCELLABLE: readonly MigrationRunStatus[] = [MigrationRunStatus.draft, MigrationRunStatus.previewing, MigrationRunStatus.previewed];

export type MigrationInboundView = Pick<MigrationInbound, 'inboundRemoteId' | 'tag' | 'protocol' | 'clientCount' | 'variantId'>;

/** A run as its page reads it: the report's counts and, on one run, the inbounds and their variants. */
export type MigrationRunView = Pick<
  MigrationRun,
  'id' | 'kind' | 'sourceFamily' | 'sourceAddress' | 'status' | 'failureReason' | 'plannedCreate' | 'plannedUpdate' | 'plannedSkip' | 'committedItems' | 'failedItems' | 'rollbackUntil' | 'createdAt' | 'updatedAt'
> & { inbounds?: MigrationInboundView[] };

const runView = (r: MigrationRun, inbounds?: MigrationInbound[]): MigrationRunView => ({
  id: r.id,
  kind: r.kind,
  sourceFamily: r.sourceFamily,
  sourceAddress: r.sourceAddress,
  status: r.status,
  failureReason: r.failureReason,
  plannedCreate: r.plannedCreate,
  plannedUpdate: r.plannedUpdate,
  plannedSkip: r.plannedSkip,
  committedItems: r.committedItems,
  failedItems: r.failedItems,
  rollbackUntil: r.rollbackUntil,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  ...(inbounds ? { inbounds: inbounds.map(({ inboundRemoteId, tag, protocol, clientCount, variantId }) => ({ inboundRemoteId, tag, protocol, clientCount, variantId })) } : {}),
});

/** One row of the report's per-user table: what was read and what is planned or was done. */
export type MigrationItemView = {
  remoteIdentity: string;
  label: string;
  inboundRemoteId: string | null;
  protocol: string | null;
  enabled: boolean | null;
  dataLimitBytes: number | null;
  usedBytes: number | null;
  expiresAt: string | null;
  plannedAction: MigrationItemAction;
  skipReason: string | null;
  outcome: MigrationItemOutcome;
  failureReason: string | null;
};

const numberOr = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const textOr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The table's row from the item's snapshot; an `unreadable` one holds its id alone, so most cells are null. */
function itemView(i: { remoteIdentity: string; sourceSnapshot: Prisma.JsonValue; plannedAction: MigrationItemAction; skipReason: string | null; outcome: MigrationItemOutcome; failureReason: string | null }): MigrationItemView {
  const s = (i.sourceSnapshot && typeof i.sourceSnapshot === 'object' && !Array.isArray(i.sourceSnapshot) ? i.sourceSnapshot : {}) as Record<string, unknown>;
  const up = numberOr(s['upBytes']);
  const down = numberOr(s['downBytes']);
  return {
    remoteIdentity: i.remoteIdentity,
    label: textOr(s['label']) || textOr(s['remoteId']) || '',
    inboundRemoteId: textOr(s['inboundRemoteId']),
    protocol: textOr(s['protocol']),
    enabled: typeof s['enabled'] === 'boolean' ? s['enabled'] : null,
    dataLimitBytes: numberOr(s['dataLimitBytes']),
    usedBytes: up === null || down === null ? null : up + down,
    expiresAt: textOr(s['expiresAt']),
    plannedAction: i.plannedAction,
    skipReason: i.skipReason,
    outcome: i.outcome,
    failureReason: i.failureReason,
  };
}

/**
 * The page re-reads (C-14): a run moved — previewed, back to draft, a commit
 * batch, its end, a cancel. To its tenant and to the admin who started it, as
 * a config move job (F-027-ev): a reseller's admin on the platform's panel is
 * on the platform tenant, so the reseller's channel never reaches them.
 */
export function announceRun(tx: Prisma.TransactionClient, run: Pick<MigrationRun, 'id' | 'tenantId' | 'actorUserId'>) {
  return tx.outboxEvent.create({
    data: { aggregate: 'entitlement.migration_run', aggregateId: run.id, type: OutboxEventType.MIGRATION_RUN_PROGRESS, payload: { tenantId: run.tenantId, userId: run.actorUserId, runId: run.id } },
  });
}

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

  /** The report's per-user table in the snapshot's order; `problems` keeps the skipped and the failed. */
  outcomes(actor: ResellerActor, tenantId: string, runId: string, page: GrantBulkPage) {
    const { page: p = 1, pageSize = 20, problems } = page;
    return this.admitted(actor, tenantId, 'read', () =>
      tenantTransaction(this.prisma, async (tx) => {
        await this.find(tx, tenantId, runId);
        const where: Prisma.MigrationItemWhereInput = { runId, ...(problems ? { OR: [{ plannedAction: MigrationItemAction.skip }, { outcome: MigrationItemOutcome.failed }] } : {}) };
        const [items, total] = await Promise.all([
          tx.migrationItem.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (p - 1) * pageSize, take: pageSize }),
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
    await this.destroyLogin(tenantId, runId);
    return view;
  }

  /** Best effort, after the run closed: a later read of a closed run destroys the login anyway (tenant rule 5). */
  async destroyLogin(tenantId: string, runId: string): Promise<void> {
    try {
      await this.logins.destroy(tenantId, runId);
    } catch (e) {
      this.logger.warn(`run ${runId}: source login not destroyed now, the vault ends it on its next read: ${errorLine(e)}`);
    }
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

  private async admitted<T>(actor: ResellerActor, tenantId: string, capability: 'read' | 'staffWrite', work: () => Promise<T>): Promise<T> {
    try {
      return await this.access.for('migration.manage').run(actor, tenantId, capability, work);
    } catch (e) {
      // The door's reasons are every reseller route's (`resellerRefusal`).
      if (e instanceof ResellerAccessRefused) throw new ResellerUserGrantsRefused(e.reason, tenantId);
      throw e;
    }
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
