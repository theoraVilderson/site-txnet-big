import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { noticeClassOf, OutboxEventType, quietUntil, retentionKindOf, SUGGESTION_NOTICE } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { GrantNoticeLevelService } from './grant-notice-level.service';
import { NotificationPreferencesService, quietWithin } from './notification-preferences.service';

/** `waitSec`: the notice may wait that long for the user's other services before it is told (F-601-p). */
export type RetentionClaim = { eventId: string; userId: string; grantId: string; notice: string; period: string; waitSec?: number };

/**
 * How a claimed notice is told (F-601-m): `now`, on every channel; `held`,
 * the inbox now and the bot at `botAt`, the end of the user's quiet hours;
 * `muted`, nobody — the row is still written, so unmuting later never tells
 * a period already past.
 */
export type ClaimAnswer = { claimed: false } | { claimed: true; deliver: 'now' | 'muted' } | { claimed: true; deliver: 'held'; botAt: string };

/** `grantId` absent: a suggestion about no service (F-038-g5). */
export type SuggestionClaim = { actionId: string; userId: string; grantId?: string };

/**
 * How an AI suggestion is told (F-038-g1): as a claim's `now` / `muted` /
 * `held`, or `later` — a retention notice on the Grant in the last 24 h wins,
 * and the suggestion may be told from `retryAt`.
 */
export type SuggestionAnswer =
  | { deliver: 'now' | 'muted' }
  | { deliver: 'held'; botAt: string }
  | { deliver: 'later'; reason: 'after_retention'; retryAt: string };

/** ADR-0109 point 10: no AI message within 24 h of a retention notice about the same Grant. */
export const SUGGESTION_AFTER_RETENTION_MS = 24 * 3_600_000;

/** F-707-q: a new lottery's announcement to one member — about no service; `eventId` is the worker's, one per lottery and member. */
export type LotteryClaim = { eventId: string; lotteryId: string; userId: string };
export type LotteryAnswer = { deliver: 'now' | 'muted' } | { deliver: 'held'; botAt: string };

export type RetentionHold = Omit<RetentionClaim, 'userId' | 'grantId'> & { grantId?: string; tenantId: string; template: string; params: Record<string, string>; botAt: string };

export type HeldNotice = { id: string; tenantId: string; userId: string; grantId: string | null; template: string; params: Record<string, string> };

/** How long a take holds its rows: a job that died mid-run gives them back after this. */
export const HELD_LEASE_SEC = 600;

/**
 * A held bot message is at most a quiet window away — plus the hour a patient
 * notice may wait before the window opens (F-601-p); a `botAt` farther out is
 * a caller's bug.
 */
const MAX_HOLD_MS = 86_400_000 + 3_600_000;

/**
 * The retention ledger (F-601-a, invariant 14): a retention notice is told
 * once per Grant period. worker-service claims the (Grant, notice, period) row
 * before it tells anyone; the unique index decides between two events racing
 * for one period, and `skipDuplicates` makes the loser a read, not an error.
 *
 * **The row is held by the event that wrote it.** The same event claims again,
 * so a notice whose send failed after its claim is still told when the event
 * is redelivered; any other event is refused.
 *
 * **The claim also says how** (F-601-m, invariant 15): the user's mute and
 * quiet hours are read here, so every producer and the bot's settings
 * (F-319) meet one rule — and so is the Grant's own level (F-601-o): a Grant
 * set to `essential` is muted for every kind. A `cutoff` kind is always
 * `now`. A row whose bot message is already held answers `held` again, so a
 * redelivery after the window ended never tells the bot a second time beside
 * the held one. A notice that may wait (`waitSec`, F-601-p) is held also
 * when the window opens before its wait ends. Only an `important` notice is
 * ever held (F-601-s, ADR-0097): `critical` and `info` are `now`.
 *
 * The app pool: the table has no `tenantId` and no RLS, and the caller is a
 * process on the internal seam, never a user.
 */
@Injectable()
export class RetentionLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly preferences: NotificationPreferencesService,
    private readonly levels: GrantNoticeLevelService,
  ) {}

  async claim(input: RetentionClaim, now = new Date()): Promise<ClaimAnswer> {
    const row = { eventId: input.eventId, userId: input.userId, grantId: input.grantId, notice: input.notice, period: input.period };
    const { count } = await this.prisma.retentionNotice.createMany({ data: [row], skipDuplicates: true });
    if (count !== 1) {
      const held = await this.prisma.retentionNotice.findUnique({
        where: { grantId_notice_period: { grantId: input.grantId, notice: input.notice, period: input.period } },
        select: { eventId: true, botAt: true, botTemplate: true },
      });
      if (held?.eventId !== input.eventId) return { claimed: false };
      if (held.botTemplate !== null && held.botAt) return { claimed: true, deliver: 'held', botAt: held.botAt.toISOString() };
    }
    const kind = retentionKindOf(input.notice);
    if (kind === 'cutoff') return { claimed: true, deliver: 'now' };
    const [pref, level] = await Promise.all([this.preferences.stored(input.userId), this.levels.level(input.userId, input.grantId)]);
    if (level === 'essential' || pref?.mutedKinds.includes(kind)) return { claimed: true, deliver: 'muted' };
    // F-601-s: quiet hours hold only an important notice's bot; a critical one ("active again") is told at once, and an info one has no bot to hold.
    if (noticeClassOf(input.notice) !== 'important') return { claimed: true, deliver: 'now' };
    const until = quietWithin(pref, now, input.waitSec ?? 0);
    return until ? { claimed: true, deliver: 'held', botAt: until.toISOString() } : { claimed: true, deliver: 'now' };
  }

  /**
   * F-038-g1 (ADR-0109 points 10, 11): an AI suggestion's claim, on the same
   * ledger — one row per action (`period` and `eventId` are the action id), so
   * a redelivery is the same row and a held bot message is never told twice.
   * In order: a retention notice on the Grant claimed in the last 24 h makes
   * it `later` (the deterministic notice wins; any claimed row counts, muted
   * or not, as the ledger does not say); the user's `suggestion` mute or the
   * Grant's `essential` level makes it `muted`; quiet hours hold the bot.
   *
   * F-038-g5: a suggestion about no service (`checkout_help`, a reseller's own)
   * has no Grant — its row is found by the action alone (a partial unique index
   * keeps it once), and the two rules about a Grant, the retention wait and the
   * `essential` level, are not read. Mute and quiet hours are the user's and hold.
   */
  async claimSuggestion(input: SuggestionClaim, now = new Date()): Promise<SuggestionAnswer> {
    const grantId = input.grantId ?? null;
    const row = { eventId: input.actionId, userId: input.userId, grantId, notice: SUGGESTION_NOTICE, period: input.actionId };
    const { count } = await this.prisma.retentionNotice.createMany({ data: [row], skipDuplicates: true });
    if (count !== 1) {
      const select = { eventId: true, botAt: true, botTemplate: true } as const;
      const held = grantId
        ? await this.prisma.retentionNotice.findUnique({ where: { grantId_notice_period: { grantId, notice: SUGGESTION_NOTICE, period: input.actionId } }, select })
        : await this.prisma.retentionNotice.findFirst({ where: { grantId: null, notice: SUGGESTION_NOTICE, period: input.actionId }, select });
      if (held?.botTemplate && held.botAt) return { deliver: 'held', botAt: held.botAt.toISOString() };
    }
    if (grantId) {
      const retention = await this.prisma.retentionNotice.findFirst({
        where: { grantId, notice: { not: SUGGESTION_NOTICE }, createdAt: { gt: new Date(now.getTime() - SUGGESTION_AFTER_RETENTION_MS) } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (retention) {
        return { deliver: 'later', reason: 'after_retention', retryAt: new Date(retention.createdAt.getTime() + SUGGESTION_AFTER_RETENTION_MS).toISOString() };
      }
    }
    const [pref, level] = await Promise.all([this.preferences.stored(input.userId), grantId ? this.levels.level(input.userId, grantId) : null]);
    if (level === 'essential' || pref?.mutedKinds.includes('suggestion')) return { deliver: 'muted' };
    const until = quietUntil(pref, now);
    return until ? { deliver: 'held', botAt: until.toISOString() } : { deliver: 'now' };
  }

  /**
   * F-707-q: a lottery's announcement to one member, on the same ledger with no
   * Grant — one row per lottery and member (`period`), so a redelivered fan-out
   * is the same row and a held bot message is never told twice. The user's
   * `lottery` mute makes it `muted`; quiet hours hold the bot. No Grant, so
   * no `essential` level and no retention wait.
   */
  async claimLottery(input: LotteryClaim, now = new Date()): Promise<LotteryAnswer> {
    const notice = OutboxEventType.LOTTERY_PUBLISHED;
    const period = lotteryPeriod(input.lotteryId, input.userId);
    const { count } = await this.prisma.retentionNotice.createMany({ data: [{ eventId: input.eventId, userId: input.userId, grantId: null, notice, period }], skipDuplicates: true });
    if (count !== 1) {
      const held = await this.prisma.retentionNotice.findFirst({ where: { grantId: null, notice, period }, select: { botAt: true, botTemplate: true } });
      if (held?.botTemplate && held.botAt) return { deliver: 'held', botAt: held.botAt.toISOString() };
    }
    const pref = await this.preferences.stored(input.userId);
    if (pref?.mutedKinds.includes(retentionKindOf(notice))) return { deliver: 'muted' };
    const until = quietUntil(pref, now);
    return until ? { deliver: 'held', botAt: until.toISOString() } : { deliver: 'now' };
  }

  /**
   * Keep a claimed notice's bot message for `botAt`: only on the row this
   * event holds, and never over one already kept — the first hold's words and
   * time stand. `false` is a row this event does not hold.
   */
  async hold(input: RetentionHold, now = new Date()): Promise<{ held: boolean }> {
    const botAt = new Date(input.botAt);
    if (!(botAt.getTime() - now.getTime() <= MAX_HOLD_MS)) throw new Error(`a held notice's botAt ${input.botAt} is more than a day and an hour away`);
    const key = { grantId: input.grantId ?? null, notice: input.notice, period: input.period, eventId: input.eventId };
    const { count } = await this.prisma.retentionNotice.updateMany({
      where: { ...key, botTemplate: null },
      data: { botTenantId: input.tenantId, botAt, botTemplate: input.template, botParams: input.params },
    });
    if (count === 1) return { held: true };
    return { held: (await this.prisma.retentionNotice.count({ where: { ...key, botTemplate: { not: null } } })) === 1 };
  }

  /** Held bot messages now due, leased to this take for {@link HELD_LEASE_SEC}; oldest first; each with its Grant, to be named (F-601-p). */
  take(limit: number): Promise<HeldNotice[]> {
    return this.prisma.$queryRaw<HeldNotice[]>(Prisma.sql`
      UPDATE "notification"."retention_notice" AS t
      SET "botAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${HELD_LEASE_SEC})
      WHERE t."id" IN (
        SELECT r."id"
        FROM "notification"."retention_notice" r
        WHERE r."botTemplate" IS NOT NULL
          AND r."botAt" <= (now() AT TIME ZONE 'UTC')
        ORDER BY r."botAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING t."id", t."botTenantId" AS "tenantId", t."userId", t."grantId", t."botTemplate" AS "template", t."botParams" AS "params"`);
  }

  /** The held messages told: nothing is held on those rows any more. */
  async told(ids: string[]): Promise<{ cleared: number }> {
    const { count } = await this.prisma.retentionNotice.updateMany({
      where: { id: { in: ids }, botTemplate: { not: null } },
      data: { botTenantId: null, botAt: null, botTemplate: null, botParams: Prisma.DbNull },
    });
    return { cleared: count };
  }
}

/** A lottery announcement's ledger period: one row per lottery and member (the grantless key is `(notice, period)`). */
export const lotteryPeriod = (lotteryId: string, userId: string) => `${lotteryId}:${userId}`;
