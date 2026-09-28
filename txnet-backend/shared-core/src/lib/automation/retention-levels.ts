import { OutboxEventType } from './routing-keys';

const DAY_MS = 86_400_000;

/**
 * How long a non-urgent retention notice waits for the other kind (F-601-n):
 * a usage and a time level due within the same 24 h are told as one message.
 */
export const RETENTION_HOLD_MS = DAY_MS;

/**
 * "Trouble connecting?" (F-601-l): a Grant that consumed something is checked
 * in on once when this long passes with nothing more. Each charge that
 * consumes a byte moves the check to its own instant plus this
 * (`idleCheckOf`), so an idle stretch is counted from its last use.
 */
export const IDLE_CHECK_AFTER_MS = 7 * DAY_MS;

/** The check-in a charge at `at` sets — metering writes it, entitlement's sweep reads it. */
export function idleCheckOf(at: Date): Date {
  return new Date(at.getTime() + IDLE_CHECK_AFTER_MS);
}

export type EndNotice = typeof OutboxEventType.GRANT_ENDS_IN_7D | typeof OutboxEventType.GRANT_ENDS_IN_3D | typeof OutboxEventType.GRANT_ENDS_IN_1D;

/**
 * A Grant's time levels (F-601-e, spec 9.5), farthest first: 7, 3 and 1 day(s)
 * before its end. One type per level, so notification's ledger holds each
 * once per end. The last is urgent and never held (F-601-n). Which of them
 * an end is told is its span's ({@link endNoticeStep}, F-601-r).
 */
export const END_NOTICE_LEVELS: ReadonlyArray<{ days: number; type: EndNotice }> = [
  { days: 7, type: OutboxEventType.GRANT_ENDS_IN_7D },
  { days: 3, type: OutboxEventType.GRANT_ENDS_IN_3D },
  { days: 1, type: OutboxEventType.GRANT_ENDS_IN_1D },
];

/** The whole days left before `end`, rounded up — what a time notice says. */
export function endNoticeDaysLeft(end: Date, now: Date): number {
  return Math.ceil((end.getTime() - now.getTime()) / DAY_MS);
}

/** A time level due and not yet told: its type, the whole days left now, and when it fell due. */
export type DueEndNotice = { type: EndNotice; days: number; dueAt: Date };

/** Under this span an end has no time notice at all, only `ended` (ADR-0097). */
const END_NOTICE_MIN_SPAN_MS = 6 * 3_600_000;

/**
 * The instants an end is told at (F-601-r, ADR-0097), farthest first. The
 * span is from when the end was set to the end. A level of L days is told
 * only if L is at most half of it: before that the user still knows how long
 * is left, because they chose it recently. A span under 2 days has one last
 * call at a quarter of it, told as the last day; one under 6 h, none.
 */
function endNoticeInstants(end: number, setAt: number): Array<{ type: EndNotice; at: number }> {
  const span = end - setAt;
  if (span < END_NOTICE_MIN_SPAN_MS) return [];
  if (span < 2 * DAY_MS) return [{ type: OutboxEventType.GRANT_ENDS_IN_1D, at: end - span / 4 }];
  return END_NOTICE_LEVELS.filter((l) => l.days * DAY_MS <= span / 2).map((l) => ({ type: l.type, at: end - l.days * DAY_MS }));
}

/**
 * One due check (F-601-e): the level due now, if any, and the instant of the
 * next level (`null` = none left for this end).
 *
 * Which levels an end has is its span's (`endSetAt` to `endsAt`, F-601-r).
 * The levels already handled for this end are those before `endNoticeAt`,
 * while `endNoticeFor` is this end. For an end seen for the first time —
 * renewed, or never checked — they are those before `activeSince`: a level
 * that fell due before the Grant was active is not news, it is the product.
 * A level is never due before its instant: nothing here is told early.
 */
export function endNoticeStep(
  g: { endsAt: Date; endSetAt: Date; activeSince: Date; endNoticeFor: Date | null; endNoticeAt: Date | null },
  now: Date,
): { notice: DueEndNotice | null; next: Date | null } {
  const end = g.endsAt.getTime();
  const t = now.getTime();
  if (end <= t) return { notice: null, next: null };

  const sameEnd = g.endNoticeFor?.getTime() === end;
  if (sameEnd && g.endNoticeAt === null) return { notice: null, next: null };
  const floor = sameEnd && g.endNoticeAt ? g.endNoticeAt.getTime() : g.activeSince.getTime();

  const levels = endNoticeInstants(end, g.endSetAt.getTime());
  // The nearest level due: a sweep late past two tells the latest truth alone.
  const due = levels.filter((l) => l.at <= t && l.at >= floor).pop();
  const upcoming = levels.find((l) => l.at > t);
  return {
    notice: due ? { type: due.type, days: endNoticeDaysLeft(g.endsAt, now), dueAt: new Date(due.at) } : null,
    next: upcoming ? new Date(upcoming.at) : null,
  };
}

/** The levels a prepaid Grant's usage period is told at (F-601-d, spec 9.5), highest first. 95 is urgent (F-601-n). */
export const USAGE_LEVELS = [95, 80, 50] as const;
export type UsageLevel = (typeof USAGE_LEVELS)[number];

/** One event type per level, so notification's `(Grant, notice, period)` ledger lets each through once. */
export const USAGE_LEVEL_EVENT: Record<UsageLevel, OutboxEventType> = {
  50: OutboxEventType.GRANT_USAGE_50,
  80: OutboxEventType.GRANT_USAGE_80,
  95: OutboxEventType.GRANT_USAGE_95,
};

const MIB = BigInt(1024 ** 2);
const GIB = BigInt(1024 ** 3);

/** What is left, as the notice says it: whole GB from 10, one decimal under, whole MB (at least 1) under 1 GB. */
export function remainingLabel(bytes: bigint): string {
  if (bytes >= BigInt(10) * GIB) return `${bytes / GIB} GB`;
  if (bytes >= GIB) {
    const tenths = (bytes * BigInt(10)) / GIB;
    return `${tenths / BigInt(10)}.${tenths % BigInt(10)} GB`;
  }
  const mb = bytes / MIB;
  return `${mb > BigInt(0) ? mb : BigInt(1)} MB`;
}

/** A usage level crossed and not yet told: the level, and when the first untold crossing of the period happened. */
export type HeldUsageNotice = { level: UsageLevel; since: Date };

/**
 * Whether a Grant's due retention notices are told now (F-601-n), or held.
 *
 * A non-urgent level — 50 / 80 %, 7 / 3 days — waits up to
 * {@link RETENTION_HOLD_MS} from when it fell due for the other kind. Both
 * kinds due: one message, now. An urgent level — 95 %, the last day — is
 * never held, and takes a held one of the other kind with it. The wait only
 * makes a notice later, never earlier, and its words are computed when told.
 */
export function retentionToTell(due: { time: DueEndNotice | null; usage: HeldUsageNotice | null }, now: Date): { usage: boolean; time: boolean } {
  const { time, usage } = due;
  const ripe = (at: Date) => at.getTime() + RETENTION_HOLD_MS <= now.getTime();
  const tell =
    (time !== null && usage !== null) ||
    time?.type === OutboxEventType.GRANT_ENDS_IN_1D ||
    usage?.level === 95 ||
    (time !== null && ripe(time.dueAt)) ||
    (usage !== null && ripe(usage.since));
  return tell ? { usage: usage !== null, time: time !== null } : { usage: false, time: false };
}

/**
 * The one retention event that tells what {@link retentionToTell} decided: a
 * usage level carrying the time level (`endNotice`, `endPeriod`, `days`) when
 * both, else the one. `remaining` and `days` are as of `now` — a held notice
 * says what is true when it is told.
 */
export function retentionEvent(
  g: { tenantId: string; userId: string; grantId: string; usagePeriod: Date; endsAt: Date | null },
  told: { usage: { level: UsageLevel; remaining: string } | null; time: DueEndNotice | null },
  now: Date,
): { type: OutboxEventType; payload: Record<string, string> } | null {
  const who = { tenantId: g.tenantId, userId: g.userId, grantId: g.grantId };
  const time = told.time && g.endsAt ? { type: told.time.type, period: g.endsAt.toISOString(), days: String(endNoticeDaysLeft(g.endsAt, now)) } : null;
  if (told.usage) {
    return {
      type: USAGE_LEVEL_EVENT[told.usage.level],
      payload: {
        ...who,
        period: g.usagePeriod.toISOString(),
        percent: String(told.usage.level),
        remaining: told.usage.remaining,
        ...(time ? { endNotice: time.type, endPeriod: time.period, days: time.days } : {}),
      },
    };
  }
  return time ? { type: time.type, payload: { ...who, period: time.period, days: time.days } } : null;
}

/**
 * The usage notice a Grant holds (F-601-n), or `null`: none written, or one
 * from a usage period a renewal has since closed — never told, it is not true.
 */
export function heldUsageNotice(g: { usageNoticeLevel: number | null; usageNoticeSince: Date | null; usagePeriod: Date }): HeldUsageNotice | null {
  const level = USAGE_LEVELS.find((l) => l === g.usageNoticeLevel);
  if (level === undefined || !g.usageNoticeSince || g.usageNoticeSince.getTime() < g.usagePeriod.getTime()) return null;
  return { level, since: g.usageNoticeSince };
}
