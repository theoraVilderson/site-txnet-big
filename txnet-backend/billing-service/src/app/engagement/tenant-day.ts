import { Prisma } from '@prisma/client';
import { resolveTimeZone, wallClock } from '@txnet-backend/shared-core';

/**
 * The wheel's day is the tenant's calendar day (ADR-0111 point 4, TZ-1): a
 * version takes effect from one, the cap and the stock count per one, and a
 * user's spins are numbered within one. Never the user's own zone — one
 * tenant's day has one cap, whoever spins.
 *
 * A day is a `DATE` column; in JS it is the UTC midnight of that calendar
 * date, which Prisma writes back as the same date.
 */
const DAY_MS = 86_400_000;

/** The tenant's calendar day at `at`, in `zone`. */
export function tenantDayOf(at: Date, zone: string): Date {
  const w = wallClock(at, zone);
  return new Date(Date.UTC(w.year, w.month - 1, w.day));
}

export function addDays(day: Date, days: number): Date {
  return new Date(day.getTime() + days * DAY_MS);
}

/** `2026-10-04` — how a day travels on the wire. */
export function isoDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}

/** The tenant's zone, through the one resolver (TZ-1): the tenant's own, else the platform's. */
export async function tenantZoneOf(tx: Prisma.TransactionClient, tenantId: string): Promise<string> {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  return resolveTimeZone({ tenant }).zone;
}
