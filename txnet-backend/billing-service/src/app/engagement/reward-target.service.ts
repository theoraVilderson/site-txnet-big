import { Injectable } from '@nestjs/common';
import { GrantStatus, Prisma, SpinPrizeType } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { GrantService } from '../entitlement/grant';
import { PrismaService } from '../prisma/prisma.service';
import { takes, type PrizeServiceName } from './reward-issuer';

/**
 * The user's prize service (F-707-r, user 2026-10-22): which of their Grants a
 * wheel or lottery prize of GB or days goes to — `/api/billing/reward-target`.
 *
 * One saved choice, not one per spin or entry: an `automatic` lottery has no
 * step to ask in, and the wheel and both lottery kinds then agree. The reward
 * issuer reads it and falls back to automatic (the Grant that runs longest)
 * when it is gone or cannot take the prize, so nothing here has to follow a
 * Grant's end; the view just stops reporting a choice that no longer applies.
 */

export type RewardTargetRejection = 'grant_not_found' | 'grant_not_eligible';

export class RewardTargetRefused extends Error {
  constructor(readonly reason: RewardTargetRejection) {
    super(reason);
    this.name = 'RewardTargetRefused';
  }
}

export type RewardTargetCaller = { userId: string; tenantId: string };

/** A service a prize can go to, named as My services names it (F-307-x): the buyer's label, else the catalog's `nameKey`. */
export type PrizeService = {
  id: string;
  label: string | null;
  variant: { id: string; sku: string; nameKey: string } | null;
  endsAt: Date | null;
  /** What is left of a capped service, in bytes (F-707-x); `null` for an unlimited or metered one. */
  remainingBytes: string | null;
  takesTraffic: boolean;
  takesDays: boolean;
};

/** `chosenGrantId` is `null` for automatic, and when the saved Grant can no longer take a prize. */
export type RewardTargetView = { chosenGrantId: string | null; services: PrizeService[] };

/** A picker, not a page: more active services than this is not a real user's. */
const SERVICES_MAX = 50;
/** My services' largest page: the current Grants' caps are read from it, the same figures that page shows. */
const CURRENT_PAGE = { pageSize: 100, scope: 'current' } as const;

/** Active, and able to take GB or days — `takes` for either kind, as a query. */
const offered = (userId: string | { in: string[] }): Prisma.GrantWhereInput => ({
  userId,
  status: GrantStatus.active,
  OR: [{ trafficUnlimited: false }, { endsAt: { not: null } }],
});

/**
 * For a lottery announcement (F-707-z): each of these users who has a choice
 * to make — two services or more a prize can reach — and the service their
 * prize would go to now, named as My services names it; `null` is automatic
 * (nothing chosen, or a choice that no longer applies). Users with one service
 * or none are left out. In the caller's tenant transaction.
 */
export async function prizeChoicesOf(tx: Prisma.TransactionClient, userIds: string[]): Promise<Record<string, PrizeServiceName | null>> {
  if (userIds.length === 0) return {};
  const [grants, chosen] = await Promise.all([
    tx.grant.findMany({
      where: offered({ in: userIds }),
      select: { id: true, userId: true, userLabel: true, variant: { select: { sku: true, nameKey: true, product: { select: { nameKey: true } } } } },
    }),
    tx.rewardTarget.findMany({ where: { userId: { in: userIds } }, select: { userId: true, grantId: true } }),
  ]);
  const byUser = new Map<string, typeof grants>();
  for (const g of grants) byUser.set(g.userId, [...(byUser.get(g.userId) ?? []), g]);
  const choiceOf = new Map(chosen.map((c) => [c.userId, c.grantId]));
  const out: Record<string, PrizeServiceName | null> = {};
  for (const [userId, own] of byUser) {
    if (own.length < 2) continue;
    const g = own.find((x) => x.id === choiceOf.get(userId));
    out[userId] = g ? { label: g.userLabel, sku: g.variant?.sku ?? null, nameKey: g.variant ? (g.variant.nameKey ?? g.variant.product.nameKey) : null } : null;
  }
  return out;
}

@Injectable()
export class RewardTargetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grants: GrantService,
  ) {}

  view(caller: RewardTargetCaller): Promise<RewardTargetView> {
    return this.withRemaining(caller, tenantTransaction(this.prisma, (tx) => this.viewIn(tx, caller)));
  }

  /** Saves the caller's own active Grant that a prize can reach; `null` is automatic again. */
  choose(caller: RewardTargetCaller, grantId: string | null): Promise<RewardTargetView> {
    return this.withRemaining(caller, this.saveIn(caller, grantId));
  }

  /**
   * Each service's GB left, from My services' own view (F-707-x): the cap there
   * is the quota plus its unexpired adjustments, worked out once in `GrantService`.
   * Read after the choice's transaction, never inside it.
   */
  private async withRemaining(caller: RewardTargetCaller, read: Promise<RewardTargetView>): Promise<RewardTargetView> {
    const [view, page] = await Promise.all([read, this.grants.listForUser(caller.userId, CURRENT_PAGE)]);
    const left = new Map(page.rows.map((r) => [r.id, r.trafficCapBytes === null ? null : bytesLeft(r.trafficCapBytes, r.consumedBytes)]));
    return { ...view, services: view.services.map((s) => ({ ...s, remainingBytes: left.get(s.id) ?? null })) };
  }

  private saveIn(caller: RewardTargetCaller, grantId: string | null): Promise<RewardTargetView> {
    return tenantTransaction(this.prisma, async (tx) => {
      const key = { tenantId: caller.tenantId, userId: caller.userId };
      if (grantId === null) {
        await tx.rewardTarget.deleteMany({ where: key });
        return this.viewIn(tx, caller);
      }
      const grant = await tx.grant.findFirst({ where: { id: grantId, userId: caller.userId }, select: { status: true, trafficUnlimited: true, endsAt: true } });
      if (!grant) throw new RewardTargetRefused('grant_not_found');
      const reachable = grant.status === GrantStatus.active && (takes(grant, SpinPrizeType.bonus_traffic_gb) || takes(grant, SpinPrizeType.extra_days));
      if (!reachable) throw new RewardTargetRefused('grant_not_eligible');
      await tx.rewardTarget.upsert({ where: { tenantId_userId: key }, create: { ...key, grantId }, update: { grantId } });
      return this.viewIn(tx, caller);
    });
  }

  private async viewIn(tx: Prisma.TransactionClient, caller: RewardTargetCaller): Promise<RewardTargetView> {
    const [rows, saved] = await Promise.all([
      tx.grant.findMany({
        where: offered(caller.userId),
        select: {
          id: true,
          userLabel: true,
          trafficUnlimited: true,
          endsAt: true,
          variant: { select: { id: true, sku: true, nameKey: true, product: { select: { nameKey: true } } } },
        },
        // The issuer's automatic order: no end first, then the latest end.
        orderBy: [{ endsAt: { sort: 'desc', nulls: 'first' } }, { startsAt: 'asc' }, { id: 'asc' }],
        take: SERVICES_MAX,
      }),
      tx.rewardTarget.findUnique({ where: { tenantId_userId: { tenantId: caller.tenantId, userId: caller.userId } }, select: { grantId: true } }),
    ]);
    const services = rows.map((r) => ({
      id: r.id,
      label: r.userLabel,
      variant: r.variant ? { id: r.variant.id, sku: r.variant.sku, nameKey: r.variant.nameKey ?? r.variant.product.nameKey } : null,
      endsAt: r.endsAt,
      remainingBytes: null,
      takesTraffic: takes(r, SpinPrizeType.bonus_traffic_gb),
      takesDays: takes(r, SpinPrizeType.extra_days),
    }));
    const chosenGrantId = services.some((s) => s.id === saved?.grantId) ? (saved?.grantId ?? null) : null;
    return { chosenGrantId, services };
  }
}

/** A cap less what was used, never below nothing. */
function bytesLeft(cap: string, used: string): string {
  const left = BigInt(cap) - BigInt(used);
  return (left > BigInt(0) ? left : BigInt(0)).toString();
}
