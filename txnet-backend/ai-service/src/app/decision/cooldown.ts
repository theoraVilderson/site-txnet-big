import type { AiActionStatus } from '@prisma/client';

/**
 * F-1504 / ADR-0109 point 8, D-12: one suggestion type falls silent for 14
 * days per subject once that subject has heard it — rolling from `sentAt`,
 * never a calendar day.
 *
 * Only what reached the subject counts: `sent`, `accepted`, `dismissed`. One
 * still waiting to go out (`scheduled`, `awaiting_approval`) holds the type
 * with no reopening time, so a second of the same type is never queued
 * behind it. `suppressed` and `expired` said nothing and start nothing.
 */

export const COOLDOWN_MS = 14 * 24 * 3_600_000;

const REACHED: readonly AiActionStatus[] = ['sent', 'accepted', 'dismissed'];
const PENDING: readonly AiActionStatus[] = ['scheduled', 'awaiting_approval'];
/** The statuses that can hold a type — what `CooldownReader` reads. */
export const COOLDOWN_STATUSES: readonly AiActionStatus[] = [...REACHED, ...PENDING];

export type PastAction = { status: AiActionStatus; sentAt: Date | null; createdAt: Date };

export type CooldownVerdict = { pass: true } | { pass: false; suppressedBy: 'cooldown'; retryAt: Date | null };

/** `past`: this subject's actions of this one type. */
export function cooldownVerdict(past: readonly PastAction[], now: Date): CooldownVerdict {
  if (past.some((a) => PENDING.includes(a.status))) return { pass: false, suppressedBy: 'cooldown', retryAt: null };
  const t = now.getTime();
  let reopensAt = 0;
  for (const a of past) {
    if (!REACHED.includes(a.status)) continue;
    // `sentAt` is set for every reached row; `createdAt` only guards a row written without it.
    reopensAt = Math.max(reopensAt, (a.sentAt ?? a.createdAt).getTime() + COOLDOWN_MS);
  }
  return reopensAt > t ? { pass: false, suppressedBy: 'cooldown', retryAt: new Date(reopensAt) } : { pass: true };
}
