import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { retentionKindOf } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { GrantNoticeLevelService } from './grant-notice-level.service';
import { NotificationPreferencesService, quietUntil } from './notification-preferences.service';

export type RetentionClaim = { eventId: string; userId: string; grantId: string; notice: string; period: string };

/**
 * How a claimed notice is told (F-601-m): `now`, on every channel; `held`,
 * the inbox now and the bot at `botAt`, the end of the user's quiet hours;
 * `muted`, nobody — the row is still written, so unmuting later never tells
 * a period already past.
 */
export type ClaimAnswer = { claimed: false } | { claimed: true; deliver: 'now' | 'muted' } | { claimed: true; deliver: 'held'; botAt: string };

export type RetentionHold = Omit<RetentionClaim, 'userId'> & { tenantId: string; template: string; params: Record<string, string>; botAt: string };

export type HeldNotice = { id: string; tenantId: string; userId: string; template: string; params: Record<string, string> };

/** How long a take holds its rows: a job that died mid-run gives them back after this. */
export const HELD_LEASE_SEC = 600;

/** A held bot message is at most a quiet window away; a `botAt` farther out is a caller's bug. */
const MAX_HOLD_MS = 86_400_000;

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
 * the held one.
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
    const until = quietUntil(pref, now);
    return until ? { claimed: true, deliver: 'held', botAt: until.toISOString() } : { claimed: true, deliver: 'now' };
  }

  /**
   * Keep a claimed notice's bot message for `botAt`: only on the row this
   * event holds, and never over one already kept — the first hold's words and
   * time stand. `false` is a row this event does not hold.
   */
  async hold(input: RetentionHold, now = new Date()): Promise<{ held: boolean }> {
    const botAt = new Date(input.botAt);
    if (!(botAt.getTime() - now.getTime() <= MAX_HOLD_MS)) throw new Error(`a held notice's botAt ${input.botAt} is more than a day away`);
    const key = { grantId: input.grantId, notice: input.notice, period: input.period, eventId: input.eventId };
    const { count } = await this.prisma.retentionNotice.updateMany({
      where: { ...key, botTemplate: null },
      data: { botTenantId: input.tenantId, botAt, botTemplate: input.template, botParams: input.params },
    });
    if (count === 1) return { held: true };
    return { held: (await this.prisma.retentionNotice.count({ where: { ...key, botTemplate: { not: null } } })) === 1 };
  }

  /** Held bot messages now due, leased to this take for {@link HELD_LEASE_SEC}; oldest first. */
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
      RETURNING t."id", t."botTenantId" AS "tenantId", t."userId", t."botTemplate" AS "template", t."botParams" AS "params"`);
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
