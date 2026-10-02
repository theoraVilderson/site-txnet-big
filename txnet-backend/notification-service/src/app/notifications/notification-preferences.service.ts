import { Injectable } from '@nestjs/common';
import { PLATFORM_DEFAULT_TIMEZONE, RETENTION_MUTABLE_KINDS, type RetentionMutableKind } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';

/** The zone a user without a row, or a panel that sent none, is read in. */
export const DEFAULT_TIMEZONE = PLATFORM_DEFAULT_TIMEZONE;

const DAY_MIN = 1440;

export type Preferences = {
  muted: RetentionMutableKind[];
  quietHours: { start: string; end: string } | null;
  timezone: string;
};

/** The stored row, as the claim reads it. */
export type StoredPreference = { mutedKinds: string[]; quietStart: number | null; quietEnd: number | null; timezone: string };

/**
 * When a bot message due at `now` may be told, under a quiet window of
 * minutes after local midnight in `timezone` (F-601-m): `null` outside the
 * window, else the window's end — the next instant the local clock reads
 * `end`, on the minute. A window may wrap midnight (23:00-08:00).
 *
 * Minutes from the local clock, not a zone table: a DST jump inside the
 * window moves the release by that hour. Asia/Tehran has kept none since 2022.
 */
export function quietUntil(pref: Pick<StoredPreference, 'quietStart' | 'quietEnd' | 'timezone'> | null, now: Date): Date | null {
  if (!pref || pref.quietStart === null || pref.quietEnd === null || pref.quietStart === pref.quietEnd) return null;
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
export function quietWithin(pref: Pick<StoredPreference, 'quietStart' | 'quietEnd' | 'timezone'> | null, now: Date, waitSec: number): Date | null {
  const inside = quietUntil(pref, now);
  if (inside || !pref || pref.quietStart === null || pref.quietEnd === null || pref.quietStart === pref.quietEnd) return inside;
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
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<Preferences> {
    return toPreferences(await this.stored(userId));
  }

  async set(userId: string, input: Preferences): Promise<Preferences> {
    const data = {
      // The tuple's order, whatever the request's, and each kind once.
      mutedKinds: RETENTION_MUTABLE_KINDS.filter((kind) => input.muted.includes(kind)),
      quietStart: input.quietHours ? toMinutes(input.quietHours.start) : null,
      quietEnd: input.quietHours ? toMinutes(input.quietHours.end) : null,
      timezone: input.timezone,
    };
    const row = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
      select: { mutedKinds: true, quietStart: true, quietEnd: true, timezone: true },
    });
    return toPreferences(row);
  }

  stored(userId: string): Promise<StoredPreference | null> {
    return this.prisma.notificationPreference.findUnique({
      where: { userId },
      select: { mutedKinds: true, quietStart: true, quietEnd: true, timezone: true },
    });
  }
}

function toPreferences(row: StoredPreference | null): Preferences {
  if (!row) return { muted: [], quietHours: null, timezone: DEFAULT_TIMEZONE };
  return {
    muted: RETENTION_MUTABLE_KINDS.filter((kind) => row.mutedKinds.includes(kind)),
    quietHours: row.quietStart === null || row.quietEnd === null ? null : { start: toClock(row.quietStart), end: toClock(row.quietEnd) },
    timezone: row.timezone,
  };
}
