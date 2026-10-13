import { AuditTargetType, type AdminAction, type Prisma } from '@prisma/client';

/** Who did an act on whom, in which tenant, from where. */
export type PersonActAt = { tenantId: string; adminId: string; userId: string; ip: string };

/** What the act changed: its action, the row before and after (null when there was none), and why. */
export type PersonAct = { action: AdminAction; before: Prisma.InputJsonValue | null; after: Prisma.InputJsonValue | null; reason: string | null };

/**
 * One staff act on a person as its `admin_audit_log` row, target `user` — a
 * key given or lifted (AC-1-l), a restriction set or lifted (F-030-d). Its id
 * is what an access history row points at (AC-1-p).
 */
export function auditPersonAct(tx: Pick<Prisma.TransactionClient, 'adminAuditLog'>, at: PersonActAt, act: PersonAct): Promise<{ id: string }> {
  return tx.adminAuditLog.create({
    data: {
      tenantId: at.tenantId,
      adminId: at.adminId,
      action: act.action,
      targetEntityType: AuditTargetType.user,
      targetEntityId: at.userId,
      oldValue: act.before ?? undefined,
      newValue: act.after ?? undefined,
      reason: act.reason,
      adminIpAddress: at.ip,
    },
    select: { id: true },
  });
}
