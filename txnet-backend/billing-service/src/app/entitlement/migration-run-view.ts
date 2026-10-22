import type { MigrationInbound, MigrationItemAction, MigrationItemOutcome, MigrationRun, Prisma } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

/*
 * What an import's pages read (entitlement `contract.import.md`,
 * `contract.link-import.md`): a run, one row of its report, and the event a
 * page re-reads on (C-14).
 */

export type MigrationInboundView = Pick<MigrationInbound, 'inboundRemoteId' | 'tag' | 'protocol' | 'clientCount' | 'variantId'>;

/** A run as its page reads it: the report's counts and, on one run, the inbounds and their variants. */
export type MigrationRunView = Pick<
  MigrationRun,
  | 'id'
  | 'kind'
  | 'sourceFamily'
  | 'sourceAddress'
  | 'status'
  | 'failureReason'
  | 'plannedCreate'
  | 'plannedUpdate'
  | 'plannedSkip'
  | 'committedItems'
  | 'failedItems'
  | 'rollbackUntil'
  | 'snapshotsPurgedAt'
  | 'userId'
  | 'variantId'
  | 'createdAt'
  | 'updatedAt'
> & { inbounds?: MigrationInboundView[] };

/** A run as its page reads it, its inbounds on one run. */
export const runView = (r: MigrationRun, inbounds?: MigrationInbound[]): MigrationRunView => ({
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
  snapshotsPurgedAt: r.snapshotsPurgedAt,
  userId: r.userId,
  variantId: r.variantId,
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
  /** Why the rollback kept the item, or its person (F-211). */
  keptReason: string | null;
  /** A link run's admin over what the link said (F-201-g); each null keeps the read figure beside it. */
  corrected: { dataLimitBytes: number | null; usedBytes: number | null; expiresAt: string | null };
  /** A balance file's row (F-209-a): its line, the amount and currency as read; null on any other run's, or once purged. */
  balance: { line: number | null; amount: string | null; currency: string | null };
};

const numberOr = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const textOr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** An item's snapshot as a record; an `unreadable` item's or a purged one's (F-211) is empty. */
const snapshotOf = (snapshot: Prisma.JsonValue): Record<string, unknown> =>
  (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {}) as Record<string, unknown>;

/** The name the source gave a client, else its id — a balance file's, the name its row gave (F-209-a); empty once the snapshot is purged. */
export function snapshotLabel(snapshot: Prisma.JsonValue): string {
  const s = snapshotOf(snapshot);
  return textOr(s['label']) || textOr(s['remoteId']) || textOr(s['user']) || '';
}

/**
 * The table's row from the item's snapshot; an `unreadable` one holds its id
 * alone, and a purged one (its window ended, F-211) nothing, so most cells are null.
 */
export function itemView(i: {
  remoteIdentity: string;
  sourceSnapshot: Prisma.JsonValue;
  plannedAction: MigrationItemAction;
  skipReason: string | null;
  outcome: MigrationItemOutcome;
  failureReason: string | null;
  keptReason: string | null;
  correctedDataLimitBytes: bigint | null;
  correctedUsedBytes: bigint | null;
  correctedExpiresAt: Date | null;
}): MigrationItemView {
  const s = snapshotOf(i.sourceSnapshot);
  const up = numberOr(s['upBytes']);
  const down = numberOr(s['downBytes']);
  return {
    remoteIdentity: i.remoteIdentity,
    label: snapshotLabel(i.sourceSnapshot),
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
    keptReason: i.keptReason,
    corrected: {
      dataLimitBytes: i.correctedDataLimitBytes === null ? null : Number(i.correctedDataLimitBytes),
      usedBytes: i.correctedUsedBytes === null ? null : Number(i.correctedUsedBytes),
      expiresAt: i.correctedExpiresAt?.toISOString() ?? null,
    },
    balance: { line: numberOr(s['line']), amount: textOr(s['amount']), currency: textOr(s['currency']) },
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
