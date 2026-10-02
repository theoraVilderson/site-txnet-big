/**
 * F-1501 / ADR-0109 point 10: how often the engine may speak to one subject
 * of its own accord. Both windows roll from the moment of each charge — never
 * a calendar day or week, so 23:59 and 00:01 are one day apart, not two.
 *
 * A count of messages, never money (C-13).
 */

const HOUR_MS = 3_600_000;

/**
 * F-1502: who started the message. `engine` — the engine chose to speak — is
 * charged; `reply` — an answer to the user's own question — never is.
 */
export const MESSAGE_ORIGINS = ['engine', 'reply'] as const;
export type MessageOrigin = (typeof MESSAGE_ORIGINS)[number];

export const ATTENTION_WINDOWS = [
  { limit: 'per_day', max: 1, ms: 24 * HOUR_MS },
  { limit: 'per_week', max: 3, ms: 7 * 24 * HOUR_MS },
] as const;

export type AttentionLimit = (typeof ATTENTION_WINDOWS)[number]['limit'];

/** The longest window: a charge older than this no longer counts anywhere. */
const KEEP_MS = Math.max(...ATTENTION_WINDOWS.map((w) => w.ms));

export type BudgetVerdict = { allowed: true } | { allowed: false; limit: AttentionLimit; retryAt: Date };

/**
 * May the subject be charged at `now`, given its recent charges? When it may
 * not, `limit` is the window that keeps it closed longest and `retryAt` the
 * moment both windows have room again.
 */
export function budgetVerdict(chargedAt: readonly Date[], now: Date): BudgetVerdict {
  const t = now.getTime();
  let refused: { limit: AttentionLimit; retryAt: number } | null = null;
  for (const w of ATTENTION_WINDOWS) {
    const inWindow = chargedAt.map((d) => d.getTime()).filter((c) => c <= t && t - c < w.ms).sort((a, b) => a - b);
    if (inWindow.length < w.max) continue;
    // The window reopens when enough of its oldest charges have aged out to leave one slot.
    const retryAt = inWindow[inWindow.length - w.max] + w.ms;
    if (!refused || retryAt > refused.retryAt) refused = { limit: w.limit, retryAt };
  }
  return refused ? { allowed: false, limit: refused.limit, retryAt: new Date(refused.retryAt) } : { allowed: true };
}

/** The list to store after charging at `now`: what still counts, oldest first, then `now`. */
export function chargedTimes(chargedAt: readonly Date[], now: Date): Date[] {
  const t = now.getTime();
  return chargedAt
    .filter((d) => t - d.getTime() < KEEP_MS)
    .sort((a, b) => a.getTime() - b.getTime())
    .concat(now);
}
