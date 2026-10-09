import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { recordAccessChange, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { AccessReader } from '../../auth/permissions/access.reader';
import type { UserAccess } from '../../auth/permissions/access';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

/** One membership past its end, as the sweep reads it across tenants. */
type Due = { id: string; tenantId: string; userId: string | null; addedByAdminId: string; expiresAt: Date | null; group: { name: string } };

const ROLE_KEYS = { role: { select: { rolePermissions: { select: { permission: { select: { key: true } } } } } } } as const;

/**
 * A membership's end is kept (GR-1-c, ADR-0139 (3)). `liveMembership` already
 * gives an ended membership nothing at the next read; this is the rest: the
 * row is removed — `notify_group_member_changed` then moves the person's
 * token after commit, so an open session loses the keys at once — and each
 * person whose answer moved is told what they lost (`access.changed`, cause
 * `group_membership_ended`, AC-1-q) and remembers it (AC-1-p).
 *
 * The clock is `worker-service`'s `group_membership_end` job, over
 * `POST /api/internal/user-groups/end-memberships`; the rule is here, beside
 * the answer it compares. Safe to run twice: a removed row is not found again,
 * and the delete re-checks the end, so an end moved later meanwhile is kept.
 *
 * The scan reads every tenant's due rows on the cross-tenant pool, by the
 * server's own clock; each tenant's are then removed and told in that
 * tenant's own transaction, under its RLS.
 */
@Injectable()
export class MembershipEndSweep {
  private readonly logger = new Logger(MembershipEndSweep.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
    private readonly answers: AccessReader,
  ) {}

  /** End up to `batch` memberships past their end, oldest end first; the next run takes the rest. */
  async endDue(now: Date = new Date(), batch = 500): Promise<{ ended: number; told: number }> {
    const due: Due[] = await this.all.userGroupMember.findMany({
      where: { expiresAt: { lte: now } },
      select: { id: true, tenantId: true, userId: true, addedByAdminId: true, expiresAt: true, group: { select: { name: true } } },
      orderBy: { expiresAt: 'asc' },
      take: batch,
    });
    const byTenant = new Map<string, Due[]>();
    for (const row of due) byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) ?? []), row]);

    let ended = 0;
    let told = 0;
    for (const [tenantId, rows] of byTenant) {
      const out = await runWithTenant({ id: tenantId }, () => tenantTransaction(this.prisma, (tx) => this.endIn(tx, tenantId, rows, now)));
      ended += out.ended;
      told += out.told;
    }
    if (ended > 0) this.logger.log(`ended ${ended} group membership(s), told ${told} person(s)`);
    return { ended, told };
  }

  private async endIn(tx: Tx, tenantId: string, rows: Due[], now: Date): Promise<{ ended: number; told: number }> {
    const userIds = [...new Set(rows.flatMap((r) => (r.userId ? [r.userId] : [])))];
    // Only the group's own tenant's people held anything through it (AC-1-m).
    const people = userIds.length === 0 ? [] : (await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, tenantId: true, ...ROLE_KEYS } })).filter((u) => u.tenantId === tenantId);
    const mine = (userId: string) => rows.filter((r) => r.userId === userId);

    // What each held just before the first of these ends: every one of them was live then.
    const before = new Map<string, UserAccess | undefined>();
    for (const person of people) {
      const first = Math.min(...mine(person.id).map((r) => (r.expiresAt as Date).getTime()));
      before.set(person.id, (await this.answers.ofLoadedMany([person], tx, new Date(first - 1))).get(person.id));
    }

    const { count } = await tx.userGroupMember.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, expiresAt: { lte: now } } });
    const after = await this.answers.ofLoadedMany(people, tx, now);

    const changes = people.flatMap((person) => {
      const was = new Set(before.get(person.id)?.keys ?? []);
      const is = new Set(after.get(person.id)?.keys ?? []);
      const given = [...is].filter((k) => !was.has(k)).sort();
      const taken = [...was].filter((k) => !is.has(k)).sort();
      if (given.length === 0 && taken.length === 0) return [];
      const ending = mine(person.id);
      return [
        {
          userId: person.id,
          tenantId,
          cause: 'group_membership_ended' as const,
          // Whoever added them with that end set it; nobody acted at the moment it passed.
          actorUserId: ending[0].addedByAdminId,
          auditLogId: null as string | null,
          detail: { group: [...new Set(ending.map((r) => r.group.name))].sort().join(', '), given, taken },
        },
      ];
    });
    await recordAccessChange(tx, changes);
    return { ended: count, told: changes.length };
  }
}
