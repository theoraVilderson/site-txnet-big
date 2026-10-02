import { Injectable } from '@nestjs/common';
import { RETENTION_MUTABLE_KINDS, type RetentionMutableKind, canonicalTimeZone, resolveTimeZone } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';

// The window rule lives in shared-core (F-038-e), so the AI engine schedules by the same one; re-exported for this unit's callers.
export { quietUntil, quietWithin } from '@txnet-backend/shared-core';

/** `timezone` null = the user's resolved zone (TZ-1-f, ADR-0108 point 6). */
export type Preferences = {
  muted: RetentionMutableKind[];
  quietHours: { start: string; end: string } | null;
  timezone: string | null;
};

/** The stored row. As the claim reads it, a row with a window always has a zone — its own, or the resolved one. */
export type StoredPreference = { mutedKinds: string[]; quietStart: number | null; quietEnd: number | null; timezone: string | null };

const SELECT = { mutedKinds: true, quietStart: true, quietEnd: true, timezone: true } as const;

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
