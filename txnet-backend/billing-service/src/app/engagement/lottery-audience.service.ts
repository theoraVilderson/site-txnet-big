import { Injectable } from '@nestjs/common';
import { LotteryEntryMode, LotteryStatus, UserGroupMemberType } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';

/** Members per page; worker-service asks again with `after` until `next` is null. */
export const AUDIENCE_PAGE_MAX = 500;

export type LotteryAudiencePage = {
  lotteryId: string;
  /** `false`: cancelled, closed or gone — nobody more is told, and the page is empty. */
  open: boolean;
  tenantId: string | null;
  title: string | null;
  entryMode: LotteryEntryMode | null;
  userIds: string[];
  /** The last user id of a full page; null when this page is the last. */
  next: string | null;
};

/**
 * Who a published lottery's announcement goes to (F-707-q): its group's user
 * members, a page at a time in user-id order, asked by worker-service as it
 * tells them. Read while the lottery is still `published` and before its
 * close, every page — so a cancel or the close stops the fan-out at the next
 * page, and nobody is told of a lottery they can no longer enter. A reseller
 * member is never told: it never enters (F-707-k).
 */
@Injectable()
export class LotteryAudienceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
  ) {}

  async page(lotteryId: string, after: string | null, limit: number, now: Date = new Date()): Promise<LotteryAudiencePage> {
    const take = Math.min(Math.max(1, limit), AUDIENCE_PAGE_MAX);
    const lot = await this.crossTenant.lottery.findUnique({
      where: { id: lotteryId },
      select: { tenantId: true, status: true, closesAt: true, title: true, entryMode: true, userGroupId: true },
    });
    const closed = { lotteryId, open: false, tenantId: lot?.tenantId ?? null, title: lot?.title ?? null, entryMode: lot?.entryMode ?? null, userIds: [], next: null };
    if (!lot || lot.status !== LotteryStatus.published || lot.closesAt.getTime() <= now.getTime()) return closed;

    const rows = await runWithTenant({ id: lot.tenantId }, () =>
      tenantTransaction(this.prisma, (tx) =>
        tx.userGroupMember.findMany({
          where: { groupId: lot.userGroupId, memberType: UserGroupMemberType.user, userId: after ? { gt: after } : { not: null } },
          select: { userId: true },
          orderBy: { userId: 'asc' },
          take,
        }),
      ),
    );
    const userIds = rows.map((r) => r.userId as string);
    return { lotteryId, open: true, tenantId: lot.tenantId, title: lot.title, entryMode: lot.entryMode, userIds, next: userIds.length === take ? userIds[userIds.length - 1] : null };
  }
}
