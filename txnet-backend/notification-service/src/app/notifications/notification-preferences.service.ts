import { Injectable } from '@nestjs/common';
import { RETENTION_MUTABLE_KINDS, type RetentionMutableKind, canonicalTimeZone, resolveTimeZone } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MIN = 1440;

/** `timezone` null = the user's resolved zone (TZ-1-f, ADR-0108 point 6). */
export type Preferences = {
  muted: RetentionMutableKind[];
  quietHours: { start: string; end: string } | null;
  timezone: string | null;
};

/** The stored row. As the claim reads it, a row with a window always has a zone — its own, or the resolved one. */
export type StoredPreference = { mutedKinds: string[]; quietStart: number | null; quietEnd: number | null; timezone: string | null };

/** What `quietUntil` reads: a window and the zone it is in. */
type QuietWindow = { quietStart: number | null; quietEnd: number | null; timezone: string | null };

const SELECT = { mutedKinds: true, quietStart: true, quietEnd: true, timezone: true } as const;

/**
 * When a bot message due at `now` may be told, under a quiet window of
 * minutes after local midnight in `timezone` (F-601-m): `null` outside the
 * window, else the window's end — the next instant the local clock reads
 * `end`, on the minute. A window may wrap midnight (23:00-08:00).
 *
 * Minutes from the local clock, not a zone table: a DST jump inside the
 * window moves the release by that hour. Asia/Tehran has kept none since 2022.
 */
export function quietUntil(pref: QuietWindow | null, now: Date): Date | null {
  if (!pref || pref.quietStart === null || pref.quietEnd === null || pref.quietStart === pref.quietEnd || pref.timezone === null) return null;
  const minute = localMinute(now, pref.timezone);
  const { quietStart: start, quietEnd: end } = pref;
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!inside) return null;
  const wait = (end - minute + DAY_MIN) % DAY_MIN;
  const onTheMinute = now.getTime() - (now.getTime() % 60_000);
  return new Date(onTheMinute + wait * 60_000);
}

/**
 * `quietUntil` for a notice that may wait up to `waitSec` before it is told
 * (F-601-p): held also when the window opens inside that wait, until the end
 * of that window — a notice claimed at 22:30 and told at 23:30 is a night one.
 */
export function quietWithin(pref: QuietWindow | null, now: Date, waitSec: number): Date | null {
  const inside = quietUntil(pref, now);
  if (inside || !pref || pref.quietStart === null || pref.quietEnd === null || pref.quietStart === pref.quietEnd || pref.timezone === null) return inside;
  const toStart = (pref.quietStart - localMinute(now, pref.timezone) + DAY_MIN) % DAY_MIN;
  if (toStart * 60 > waitSec) return null;
  const onTheMinute = now.getTime() - (now.getTime() % 60_000);
  return quietUntil(pref, new Date(onTheMinute + toStart * 60_000));
}

function localMinute(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return (part('hour') % 24) * 60 + part('minute');
}

const toMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const toClock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * A user's retention notice preferences (F-601-m, spec 9.4): the kinds they
 * muted and a quiet-hours window in their zone. Read by the ledger at the
 * claim; written only by the user, through the gate's `userId` (invariant 15).
 * No row is the default — nothing muted, no quiet hours.
 *
 * The app pool: `notification_preference` has no `tenantId` and no RLS, like
 * `notification`, so the `userId` filter is the whole guard.
 *
 * **The zone** (TZ-1-f, ADR-0108 point 6): a row's own, or — null — the
 * user's resolved zone, read from `identity.user` and its tenant on the
 * cross-tenant pool: the claim's caller is a process with no tenant bound, and
 * `identity.user` is under RLS. Read only for a row with a window and no zone.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
  ) {}

  async get(userId: string): Promise<Preferences> {
    return toPreferences(await this.row(userId));
  }

  async set(userId: string, input: Preferences): Promise<Preferences> {
    const data = {
      // The tuple's order, whatever the request's, and each kind once.
      mutedKinds: RETENTION_MUTABLE_KINDS.filter((kind) => input.muted.includes(kind)),
      quietStart: input.quietHours ? toMinutes(input.quietHours.start) : null,
      quietEnd: input.quietHours ? toMinutes(input.quietHours.end) : null,
      // Canonical, like every stored zone (identity/contract.time-zone.md rule 3).
      timezone: input.timezone === null ? null : canonicalTimeZone(input.timezone),
    };
    const row = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
      select: SELECT,
    });
    return toPreferences(row);
  }

  /** The row as the claim reads it: a window with no zone of its own is in the user's resolved zone. */
  async stored(userId: string): Promise<StoredPreference | null> {
    const row = await this.row(userId);
    if (!row || row.quietStart === null || row.quietEnd === null || row.timezone !== null) return row;
    const user = await this.all.user.findUnique({
      where: { id: userId },
      select: { timezone: true, timezoneSource: true, tenant: { select: { timezone: true } } },
    });
    return { ...row, timezone: resolveTimeZone({ user, tenant: user?.tenant }).zone };
  }

  private row(userId: string): Promise<StoredPreference | null> {
    return this.prisma.notificationPreference.findUnique({ where: { userId }, select: SELECT });
  }
}

function toPreferences(row: StoredPreference | null): Preferences {
  if (!row) return { muted: [], quietHours: null, timezone: null };
  return {
    muted: RETENTION_MUTABLE_KINDS.filter((kind) => row.mutedKinds.includes(kind)),
    quietHours: row.quietStart === null || row.quietEnd === null ? null : { start: toClock(row.quietStart), end: toClock(row.quietEnd) },
    timezone: row.timezone,
  };
}
