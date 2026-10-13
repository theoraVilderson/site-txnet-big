import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { recordAccessChange, runWithTenant, tenantTransaction, type AccessChange } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { answerMoved, type UserAccess } from './access';
import { AccessReader } from './access.reader';

type Tx = Prisma.TransactionClient;

/** One key whose window opens or closes, as the sweep reads it across tenants. */
type Due = { userId: string; permissionId: string; tenantId: string; grantedByUserId: string; startsAt: Date | null; endsAt: Date | null };

const ROLE_KEYS = { role: { select: { rolePermissions: { select: { permission: { select: { key: true } } } } } } } as const;

/** A window that has started and nobody was told, or one that has ended. */
const dueAt = (now: Date): Prisma.UserPermissionWhereInput => ({
  OR: [{ startsAt: { lte: now }, openedAt: null }, { endsAt: { lte: now } }],
});

/** The moment this row's window moved: its end if passed, else its start. */
const movedAt = (row: Due, now: Date): Date => (row.endsAt && row.endsAt <= now ? row.endsAt : (row.startsAt as Date));

/**
 * A key given for a window (F-030-a, ADR-0138 (7)). `liveKeyWindow` already
 * counts it only inside the window at the next read; this is the rest. At its
 * start the row is marked `openedAt`, at its end it is removed — either way a
 * write, so `user_permission_changed` moves the person's token after commit
 * and an open session gains or loses the key at once — and each person whose
 * answer moved is told (`access.changed`, cause `key_window`, AC-1-q) and
 * remembers it (AC-1-p).
 *
 * The clock is `worker-service`'s `key_window` job, over
 * `POST /api/internal/user-keys/windows`; GR-1-c's `MembershipEndSweep` is the
 * same shape. Safe to run twice: a marked or removed row is not found again,
 * and each write re-checks the time, so a window moved meanwhile is kept.
 */
@Injectable()
export class KeyWindowSweep {
  private readonly logger = new Logger(KeyWindowSweep.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
    private readonly answers: AccessReader,
  ) {}

  /** Open and close up to `batch` windows, oldest first; the next run takes the rest. */
  async moveDue(now: Date = new Date(), batch = 500): Promise<{ opened: number; closed: number; told: number }> {
    const due: Due[] = await this.all.userPermission.findMany({
      where: dueAt(now),
      select: { userId: true, permissionId: true, tenantId: true, grantedByUserId: true, startsAt: true, endsAt: true },
      orderBy: [{ endsAt: 'asc' }, { startsAt: 'asc' }],
      take: batch,
    });
    const byTenant = new Map<string, Due[]>();
    for (const row of due) byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) ?? []), row]);

    const total = { opened: 0, closed: 0, told: 0 };
    for (const [tenantId, rows] of byTenant) {
      const out = await runWithTenant({ id: tenantId }, () => tenantTransaction(this.prisma, (tx) => this.moveIn(tx, tenantId, rows, now)));
      total.opened += out.opened;
      total.closed += out.closed;
      total.told += out.told;
    }
    if (total.opened + total.closed > 0) this.logger.log(`opened ${total.opened} and closed ${total.closed} key window(s), told ${total.told} person(s)`);
    return total;
  }

  private async moveIn(tx: Tx, tenantId: string, rows: Due[], now: Date): Promise<{ opened: number; closed: number; told: number }> {
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const people = await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, ...ROLE_KEYS } });
    const mine = (userId: string) => rows.filter((r) => r.userId === userId);

    // What each held just before the first of their windows moved.
    const before = new Map<string, UserAccess | undefined>();
    for (const person of people) {
      const first = Math.min(...mine(person.id).map((r) => movedAt(r, now).getTime()));
      before.set(person.id, (await this.answers.ofLoadedMany([person], tx, new Date(first - 1))).get(person.id));
    }

    const ending = rows.filter((r) => r.endsAt && r.endsAt <= now);
    const opening = rows.filter((r) => !ending.includes(r));
    const pair = (r: Due) => ({ userId: r.userId, permissionId: r.permissionId });
    const closed = ending.length === 0 ? 0 : (await tx.userPermission.deleteMany({ where: { OR: ending.map(pair), endsAt: { lte: now } } })).count;
    const opened =
      opening.length === 0 ? 0 : (await tx.userPermission.updateMany({ where: { OR: opening.map(pair), startsAt: { lte: now }, openedAt: null }, data: { openedAt: now } })).count;
    const after = await this.answers.ofLoadedMany(people, tx, now);

    const changes: AccessChange[] = people.flatMap((person) => {
      const detail = answerMoved(before.get(person.id), after.get(person.id));
      if (detail.given.length === 0 && detail.taken.length === 0) return [];
      // Whoever gave the key with that window set it; nobody acted at the moment it moved.
      return [{ userId: person.id, tenantId, cause: 'key_window' as const, actorUserId: mine(person.id)[0].grantedByUserId, auditLogId: null as string | null, detail }];
    });
    await recordAccessChange(tx, changes);
    return { opened, closed, told: changes.length };
  }
}
