import { randomBytes, randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { FraudSubjectType, LotteryEntryMode, LotteryStatus, Prisma, UserGroupMemberType, UserStatus } from '@prisma/client';
import { LOTTERY_ALGORITHM, lotteryListHash, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { FINGERPRINT_FREE_GRANTS_REFUSED_AT, FINGERPRINT_WINDOW_DAYS } from '../fraud/device-fingerprint';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { LotterySeedSeal } from './lottery-seed-seal';

/**
 * A lottery's close: the freeze (F-707-k, ADR-0111 points 5, 6), run by the
 * worker's `lottery_close` tick through `close-due`.
 *
 * **One transaction, in this order.** The lottery row is locked `FOR UPDATE`
 * (a join or a leave holds it `FOR SHARE`, so the list stops moving here);
 * every candidate is judged on what is true now and gets a ticket or a
 * reason; the list hash is taken over the tickets; **only then** the seed is
 * made — `crypto.randomBytes(32)` — sealed (ADR-0022) and written with the
 * hash into the draw row; the lottery moves to `frozen` last. Nothing is
 * committed unless all of it is, so the seed never exists beside a list that
 * could still change, and once committed no rerun can make another (the draw
 * row's key is the lottery; user, 2026-10-03: sealed at the freeze, not at
 * the draw). The draw itself is F-707-l's.
 *
 * **Who enters.** `automatic`: every user member of the group. `opt_in`: who
 * joined (F-707-j); one taken out of the group since is `not_in_group`. A
 * reseller member of a platform group never enters and is counted
 * (`skippedResellerCount`, point 6). Then the rules: an active account, the
 * lottery's account age and phone rules, no open fraud flag, and no device
 * behind 5 accounts in 30 days (D-11). A member with no device recorded
 * enters (user, 2026-10-03). Tickets go to the eligible by entry time, then
 * user id — fair whatever the order, since no seed exists yet.
 *
 * **Safe to run twice** (ADR-0027): a lottery is taken only while
 * `published` and past its close, under the row lock. A KEK that is not
 * loaded fails the lottery whole; it stays open and is tried next tick.
 */

export type ExclusionReason = 'not_in_group' | 'inactive' | 'account_too_new' | 'phone_unverified' | 'flagged' | 'shared_device';

/** Lotteries frozen per run; the rest wait a minute. */
const CLOSE_BATCH = 50;

export type CandidateFacts = {
  status: UserStatus;
  deletedAt: Date | null;
  createdAt: Date;
  phoneVerifiedAt: Date | null;
  openFlags: number;
  /** The most accounts on any of the user's devices seen in the window; 0 when none is recorded. */
  accountsOnFingerprint: number;
};

/** The first rule a candidate fails, or `null`. `facts` is undefined for an account that is gone. */
export function judgeCandidate(
  c: { inGroup: boolean },
  facts: CandidateFacts | undefined,
  rules: { requiresPhoneVerified: boolean; requiresMinAccountAgeHours: number },
  at: Date,
): ExclusionReason | null {
  if (!c.inGroup) return 'not_in_group';
  if (!facts || facts.status !== UserStatus.active || facts.deletedAt !== null) return 'inactive';
  if (at.getTime() - facts.createdAt.getTime() < rules.requiresMinAccountAgeHours * 3_600_000) return 'account_too_new';
  if (rules.requiresPhoneVerified && facts.phoneVerifiedAt === null) return 'phone_unverified';
  if (facts.openFlags > 0) return 'flagged';
  if (facts.accountsOnFingerprint >= FINGERPRINT_FREE_GRANTS_REFUSED_AT) return 'shared_device';
  return null;
}

export type CloseDueResult = { scanned: number; frozen: number; failed: number };

type LockedLottery = {
  id: string;
  tenantId: string;
  userGroupId: string;
  entryMode: LotteryEntryMode;
  requiresPhoneVerified: boolean;
  requiresMinAccountAgeHours: number;
};

export type Candidate = { userId: string; entrantId: string; existing: boolean; optedInAt: Date | null; inGroup: boolean };

@Injectable()
export class LotteryCloseService {
  private readonly logger = new Logger(LotteryCloseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly seeds: LotterySeedSeal,
  ) {}

  async closeDue(now: Date = new Date()): Promise<CloseDueResult> {
    const due = await this.crossTenant.lottery.findMany({
      where: { status: LotteryStatus.published, closesAt: { lte: now } },
      select: { id: true, tenantId: true },
      orderBy: { closesAt: 'asc' },
      take: CLOSE_BATCH,
    });
    const result: CloseDueResult = { scanned: due.length, frozen: 0, failed: 0 };
    for (const lot of due) {
      try {
        const frozen = await runWithTenant({ id: lot.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.freeze(tx, lot.id, now)));
        if (frozen) result.frozen += 1;
      } catch (e) {
        result.failed += 1;
        this.logger.warn(`freezing lottery ${lot.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return result;
  }

  /** `false`: another run, or a cancel, got there first. */
  private async freeze(tx: Prisma.TransactionClient, lotteryId: string, now: Date): Promise<boolean> {
    const [lot] = await tx.$queryRaw<LockedLottery[]>`SELECT id, "tenantId", "userGroupId", "entryMode", "requiresPhoneVerified", "requiresMinAccountAgeHours"
      FROM engagement.lottery WHERE id = ${lotteryId}::uuid AND status = 'published' AND "closesAt" <= ${now} FOR UPDATE`;
    if (!lot) return false;

    const { candidates, skippedResellerCount } = await lotteryCandidates(tx, lot);

    const facts = await candidateFacts(tx, lot.tenantId, [...candidates.keys()], now);
    const judged = [...candidates.values()].map((c) => ({ c, reason: judgeCandidate(c, facts.get(c.userId), lot, now) }));
    const eligible = judged
      .filter((j) => j.reason === null)
      .map((j) => j.c)
      .sort((a, b) => (a.optedInAt?.getTime() ?? 0) - (b.optedInAt?.getTime() ?? 0) || a.userId.localeCompare(b.userId));
    const ticketOf = new Map(eligible.map((c, i) => [c.userId, i + 1]));

    // The list, written while the lottery is still `published` (the entrant guard allows nothing later).
    const fresh = judged.filter((j) => !j.c.existing);
    if (fresh.length > 0) {
      await tx.lotteryEntrant.createMany({
        data: fresh.map(({ c, reason }) => ({ id: c.entrantId, tenantId: lot.tenantId, lotteryId, userId: c.userId, ticketNumber: ticketOf.get(c.userId) ?? null, excludedReason: reason })),
      });
    }
    for (const { c, reason } of judged.filter((j) => j.c.existing)) {
      await tx.lotteryEntrant.update({ where: { id: c.entrantId }, data: { ticketNumber: ticketOf.get(c.userId) ?? null, excludedReason: reason } });
    }
    const listHash = await lotteryListHash(
      lotteryId,
      eligible.map((c) => ({ ticketNumber: ticketOf.get(c.userId) as number, entrantId: c.entrantId })),
    );

    // Only now, with the list fixed and hashed, does the seed exist. It is never logged nor returned.
    const seedSealed = this.seeds.seal(randomBytes(32).toString('hex'));
    if (!seedSealed) throw new Error('no KEK is loaded: the seed cannot be sealed, the lottery stays open');

    await tx.lotteryDraw.create({
      data: {
        lotteryId,
        tenantId: lot.tenantId,
        entrantCount: eligible.length,
        skippedResellerCount,
        listHash,
        seedSealed: seedSealed as unknown as Prisma.InputJsonValue,
        algorithm: LOTTERY_ALGORITHM,
        frozenAt: now,
        drawnAt: null,
      },
    });
    const { count } = await tx.lottery.updateMany({ where: { id: lotteryId, status: LotteryStatus.published }, data: { status: LotteryStatus.frozen } });
    if (count !== 1) throw new Error(`lottery ${lotteryId} left published under its lock`);
    this.logger.log(`lottery ${lotteryId} frozen: ${eligible.length} ticket(s), ${judged.length - eligible.length} excluded, ${skippedResellerCount} reseller(s) skipped`);
    return true;
  }
}

/**
 * Who the close judges (the "Who enters" rule above): `automatic`, every user
 * member of the group; `opt_in`, who joined. A reseller member is counted,
 * never judged. Also the admin's preview (F-707-o), so it counts as the
 * freeze will.
 */
export async function lotteryCandidates(
  tx: Prisma.TransactionClient,
  lot: { id: string; userGroupId: string; entryMode: LotteryEntryMode },
): Promise<{ candidates: Map<string, Candidate>; userMembers: Set<string>; skippedResellerCount: number }> {
  const members = await tx.userGroupMember.findMany({ where: { groupId: lot.userGroupId }, select: { memberType: true, userId: true } });
  const userMembers = new Set(members.filter((m) => m.memberType === UserGroupMemberType.user && m.userId).map((m) => m.userId as string));
  const skippedResellerCount = members.filter((m) => m.memberType === UserGroupMemberType.tenant).length;

  const rows = await tx.lotteryEntrant.findMany({ where: { lotteryId: lot.id }, select: { id: true, userId: true, optedInAt: true } });
  const candidates = new Map<string, Candidate>(rows.map((r) => [r.userId, { userId: r.userId, entrantId: r.id, existing: true, optedInAt: r.optedInAt, inGroup: userMembers.has(r.userId) }]));
  if (lot.entryMode === LotteryEntryMode.automatic) {
    for (const userId of userMembers) {
      if (!candidates.has(userId)) candidates.set(userId, { userId, entrantId: randomUUID(), existing: false, optedInAt: null, inGroup: true });
    }
  }
  return { candidates, userMembers, skippedResellerCount };
}

/** Each user's facts the rules judge, as of `now`; a user gone from the table has none. */
export async function candidateFacts(tx: Prisma.TransactionClient, tenantId: string, userIds: string[], now: Date): Promise<Map<string, CandidateFacts>> {
  if (userIds.length === 0) return new Map();
  const since = new Date(now.getTime() - FINGERPRINT_WINDOW_DAYS * 86_400_000);
  const [users, flags, devices] = await Promise.all([
    tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, status: true, deletedAt: true, createdAt: true, phoneVerifiedAt: true } }),
    tx.fraudFlag.findMany({ where: { subjectType: FraudSubjectType.user, subjectId: { in: userIds }, resolvedAt: null }, select: { subjectId: true } }),
    // Per user, the most accounts on any one of its devices in the window (D-11).
    tx.$queryRaw<Array<{ userId: string; accounts: number }>>`SELECT f."userId"::text AS "userId", max(c.n)::int AS accounts
      FROM fraud.device_fingerprint f
      CROSS JOIN LATERAL (SELECT count(DISTINCT g."userId") AS n FROM fraud.device_fingerprint g
        WHERE g."tenantId" = f."tenantId" AND g."fingerprintHash" = f."fingerprintHash" AND g."lastSeenAt" >= ${since}) c
      WHERE f."tenantId" = ${tenantId}::uuid AND f."userId" = ANY(${userIds}::uuid[]) AND f."lastSeenAt" >= ${since}
      GROUP BY f."userId"`,
  ]);
  const flagged = new Map<string, number>();
  for (const f of flags) flagged.set(f.subjectId, (flagged.get(f.subjectId) ?? 0) + 1);
  const shared = new Map(devices.map((d) => [d.userId, Number(d.accounts)]));
  return new Map(
    users.map((u) => [
      u.id,
      { status: u.status, deletedAt: u.deletedAt, createdAt: u.createdAt, phoneVerifiedAt: u.phoneVerifiedAt, openFlags: flagged.get(u.id) ?? 0, accountsOnFingerprint: shared.get(u.id) ?? 0 },
    ]),
  );
}
