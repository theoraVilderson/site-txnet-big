import { GrantSource } from '@prisma/client';

const HOUR_MS = 3_600_000;

/** The two "not connected yet?" asks, counted from activation (F-601-c, user 2026-09-27). */
export const UNUSED_FIRST_AFTER_MS = 24 * HOUR_MS;
export const UNUSED_SECOND_AFTER_MS = 72 * HOUR_MS;

/** A Grant carried over from somewhere else was in use before it was ours to ask about. */
const NEVER_ASKED: ReadonlySet<GrantSource> = new Set([GrantSource.migration, GrantSource.rollover]);

/**
 * The first check of a Grant activated at `activatedAt`, or `null` when it is
 * never asked. Its own file so `markDelivered` and `issue` start the clock
 * without importing the sweep (`unused-notice.ts`), which imports them.
 */
export function unusedClockOf(source: GrantSource, activatedAt: Date): Date | null {
  return NEVER_ASKED.has(source) ? null : new Date(activatedAt.getTime() + UNUSED_FIRST_AFTER_MS);
}
