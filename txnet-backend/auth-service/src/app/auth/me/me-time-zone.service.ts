import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  canonicalTimeZone,
  nextUserZone,
  ok,
  resolveTimeZone,
  type ResolvedTimeZone,
  type TimeZoneSource,
} from '@txnet-backend/shared-core';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthClaims } from '../token.service';

/**
 * `timezone`/`source`: what the caller's row holds (null = none of their own).
 * `resolved`: the zone a wall-clock question about them is answered in, and from where.
 * `applied` (on a save): whether the report is now what is stored — false when a
 * browser report met a zone the user chose.
 */
export type MeTimeZone = { timezone: string | null; source: TimeZoneSource | null; resolved: ResolvedTimeZone; applied?: boolean };

export type TimeZoneReport = { zone: string | null; source: TimeZoneSource };

const SELECT = { timezone: true, timezoneSource: true, tenant: { select: { timezone: true } } } satisfies Prisma.UserSelect;

type Stored = Prisma.UserGetPayload<{ select: typeof SELECT }>;

/**
 * The caller's own time zone (TZ-1-c, ADR-0108 point 4). The panel reports
 * its browser's zone as `browser` after sign-in; the user chooses as `user`.
 * Which one wins is shared-core's `nextUserZone`; this adds the one thing a
 * pure function cannot — a browser write is conditional in the same
 * statement, so a choice saved between the read and the write survives.
 */
@Injectable()
export class MeTimeZoneService {
  constructor(private readonly prisma: PrismaService) {}

  async read(claims: AuthClaims) {
    return ok(answer(await this.load(claims)), 'auth.timezone');
  }

  async save(claims: AuthClaims, report: TimeZoneReport) {
    const before = await this.load(claims);
    const next = nextUserZone({ timezone: before?.timezone ?? null, timezoneSource: before?.timezoneSource ?? null }, report);
    if (!next) return ok({ ...answer(before), applied: holds(before, report) }, 'auth.timezoneSaved');
    const where: Prisma.UserWhereInput =
      report.source === 'browser' ? { id: claims.sub, OR: [{ timezoneSource: null }, { timezoneSource: 'browser' }] } : { id: claims.sub };
    await this.prisma.user.updateMany({ where, data: next });
    const after = await this.load(claims);
    return ok({ ...answer(after), applied: holds(after, report) }, 'auth.timezoneSaved');
  }

  private load(claims: AuthClaims): Promise<Stored | null> {
    return this.prisma.user.findUnique({ where: { id: claims.sub }, select: SELECT });
  }
}

function answer(user: Stored | null): MeTimeZone {
  const own = { timezone: user?.timezone ?? null, timezoneSource: user?.timezoneSource ?? null };
  return { timezone: own.timezone, source: own.timezoneSource, resolved: resolveTimeZone({ user: own, tenant: user?.tenant }) };
}

/** Whether the row now holds what was reported (a clear holds when both columns are null). */
function holds(user: Stored | null, report: TimeZoneReport): boolean {
  const zone = report.zone === null ? null : canonicalTimeZone(report.zone);
  if (zone === null) return (user?.timezone ?? null) === null;
  return user?.timezone === zone && user?.timezoneSource === report.source;
}
