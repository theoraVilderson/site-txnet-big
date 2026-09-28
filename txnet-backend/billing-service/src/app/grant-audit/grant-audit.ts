import { AdminAction, AuditTargetType, Prisma } from '@prisma/client';

import { adminNoticeOf, configNoticeOf, emitAdminNotice } from './admin-notice';

/**
 * An admin's act on a user's Grant or config, written down (F-311-r, audit
 * unit): one `admin_audit_log` row — actor, target, before, after, reason —
 * **in the transaction that performs the act** (audit invariant #12). A
 * refusal throws before the row and rolls back with the act; a repeat that
 * changed nothing (`renewed: false`, `issued: false`) writes none.
 *
 * Before and after are the target's own columns read on either side of the
 * act, so a row never claims a state the act did not leave; `outcome` adds
 * what lives off the row (a quota's bytes, a speed cap, a refund). Neither
 * ever carries a token or a link: a rotation's outcome is the time, not the URL.
 *
 * Every act is told to the user (F-311-s): its notice is written beside the
 * row, in the same transaction, the row's id its period (`admin-notice.ts`).
 * A config's act is told on the config's Grant.
 */
export type AuditActor = { userId: string; ip: string };

export type GrantAuditAction = Extract<
  AdminAction,
  | 'grant_freeze'
  | 'grant_unfreeze'
  | 'grant_duration_change'
  | 'grant_traffic_change'
  | 'grant_traffic_reset'
  | 'grant_traffic_gift'
  | 'grant_speed_set'
  | 'grant_devices_set'
  | 'grant_delete'
  | 'grant_issue'
  | 'grant_renew'
  | 'grant_link_rotate'
>;

export type ConfigAuditAction = Extract<AdminAction, 'config_regenerate' | 'config_disable' | 'config_enable' | 'config_retire' | 'config_move'>;

/** The Grant's columns an admin act can move — never its token hash or sealed token. */
const GRANT_STATE = { status: true, statusReason: true, endsAt: true, purchasedBytes: true, quotas: true, tokenRotatedAt: true } as const;
const CONFIG_STATE = { grantId: true, panelId: true, status: true, disabledReason: true, desiredEnabled: true, desiredRemote: true } as const;

/** What each act may add from its result; absent, only the columns are written. */
export type AuditSpec<T> = {
  action: GrantAuditAction;
  reason: string | null;
  /** False for a repeat that changed nothing: no row. */
  changed?: (result: T) => boolean;
  outcome?: (result: T) => unknown;
};

/**
 * `act` on `grantId` in `tx`, written down. `targetOf` names the Grant when
 * the act creates it (an issue): there is no before, and the id is the result's.
 */
export async function auditedGrantAct<T>(
  tx: Prisma.TransactionClient,
  actor: AuditActor,
  tenantId: string,
  grantId: string | null,
  spec: AuditSpec<T> & { targetOf?: (result: T) => string },
  act: () => Promise<T>,
): Promise<T> {
  const before = grantId ? await tx.grant.findUnique({ where: { id: grantId }, select: GRANT_STATE }) : null;
  const result = await act();
  if (spec.changed && !spec.changed(result)) return result;
  const target = spec.targetOf ? spec.targetOf(result) : (grantId as string);
  const after = await tx.grant.findUnique({ where: { id: target }, select: GRANT_STATE });
  const auditId = await write(tx, actor, tenantId, spec.action, AuditTargetType.grant, target, before, { ...after, outcome: spec.outcome?.(result) }, spec.reason);
  await emitAdminNotice(tx, tenantId, target, auditId, adminNoticeOf(spec.action, result));
  return result;
}

/** One config's act (F-311-g), written down against the config; a move's new config is its outcome. */
export async function auditedConfigAct<T extends string | void>(
  tx: Prisma.TransactionClient,
  actor: AuditActor,
  tenantId: string,
  configId: string,
  action: ConfigAuditAction,
  reason: string | null,
  act: () => Promise<T>,
): Promise<T> {
  const before = await tx.config.findUnique({ where: { id: configId }, select: CONFIG_STATE });
  const movedTo = await act();
  const after = await tx.config.findUnique({ where: { id: configId }, select: CONFIG_STATE });
  const auditId = await write(tx, actor, tenantId, action, AuditTargetType.config, configId, before, { ...after, outcome: movedTo ? { movedTo } : undefined }, reason);
  const grantId = after?.grantId ?? before?.grantId;
  if (!grantId) throw new Error(`config ${configId} was audited and is gone`);
  await emitAdminNotice(tx, tenantId, grantId, auditId, configNoticeOf(action));
  return movedTo;
}

export type GrantHistoryRow = {
  id: string;
  action: AdminAction;
  targetType: AuditTargetType;
  targetId: string;
  actorUserId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  at: string;
};

/**
 * A Grant's history (F-311-r): every audited act on it and on any config it
 * ever held — a retired or moved one included — newest first. The admin's IP
 * is kept in the row and not answered here: the reader is the reseller.
 */
export async function grantHistory(
  tx: Prisma.TransactionClient,
  grantId: string,
  page: { page: number; pageSize: number },
): Promise<{ rows: GrantHistoryRow[]; page: number; pageSize: number; total: number }> {
  const configs = await tx.config.findMany({ where: { grantId }, select: { id: true } });
  const where: Prisma.AdminAuditLogWhereInput = {
    OR: [
      { targetEntityType: AuditTargetType.grant, targetEntityId: grantId },
      ...(configs.length ? [{ targetEntityType: AuditTargetType.config, targetEntityId: { in: configs.map((c) => c.id) } }] : []),
    ],
  };
  const [rows, total] = await Promise.all([
    tx.adminAuditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
    }),
    tx.adminAuditLog.count({ where }),
  ]);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      action: r.action,
      targetType: r.targetEntityType,
      targetId: r.targetEntityId,
      actorUserId: r.adminId,
      before: r.oldValue,
      after: r.newValue,
      reason: r.reason,
      at: r.createdAt.toISOString(),
    })),
    page: page.page,
    pageSize: page.pageSize,
    total,
  };
}

async function write(
  tx: Prisma.TransactionClient,
  actor: AuditActor,
  tenantId: string,
  action: AdminAction,
  targetEntityType: AuditTargetType,
  targetEntityId: string,
  before: unknown,
  after: unknown,
  reason: string | null,
): Promise<string> {
  const row = await tx.adminAuditLog.create({
    data: {
      tenantId,
      adminId: actor.userId,
      action,
      targetEntityType,
      targetEntityId,
      oldValue: before === null ? Prisma.DbNull : json(before),
      newValue: json(after),
      adminIpAddress: actor.ip,
      reason,
    },
    select: { id: true },
  });
  return row.id;
}

/** Bytes as strings and instants as ISO text, so a row reads back as it was written. */
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as Prisma.InputJsonValue;
}
