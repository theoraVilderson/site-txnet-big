import { OutboxEventType } from './routing-keys';

const DAY_MS = 86_400_000;

export type EndNotice = typeof OutboxEventType.GRANT_ENDS_IN_7D | typeof OutboxEventType.GRANT_ENDS_IN_3D | typeof OutboxEventType.GRANT_ENDS_IN_1D;

/**
 * A Grant's time levels (F-601-e, spec 9.5), farthest first: 7, 3 and 1 day(s)
 * before its end. One type per level, so notification's ledger holds each
 * once per end. billing's end sweep tells them; metering names the one a usage
 * notice carries ({@link endNoticeAhead}).
 */
export const END_NOTICE_LEVELS: ReadonlyArray<{ days: number; type: EndNotice }> = [
  { days: 7, type: OutboxEventType.GRANT_ENDS_IN_7D },
  { days: 3, type: OutboxEventType.GRANT_ENDS_IN_3D },
  { days: 1, type: OutboxEventType.GRANT_ENDS_IN_1D },
];

/** How far ahead a usage notice looks for a time level to carry (F-601-f): the same 24 h. */
export const END_NOTICE_AHEAD_MS = DAY_MS;

/** The whole days left before `end`, rounded up — what a time notice says. */
export function endNoticeDaysLeft(end: Date, now: Date): number {
  return Math.ceil((end.getTime() - now.getTime()) / DAY_MS);
}

/**
 * The time level due within the next 24 h, which a usage notice told now
 * carries into one message (F-601-f), or `null`.
 *
 * The nearest such level alone, as a late sweep tells the latest truth, and
 * never one that fell due before the Grant was active — the sweep passes
 * those untold. A level that is due but not yet swept is named too; one the
 * sweep already told is refused by notification's ledger, and the usage
 * notice is then told alone.
 */
export function endNoticeAhead(g: { endsAt: Date; activeSince: Date }, now: Date): { type: EndNotice; days: number } | null {
  const end = g.endsAt.getTime();
  if (end <= now.getTime()) return null;
  const horizon = now.getTime() + END_NOTICE_AHEAD_MS;
  const level = END_NOTICE_LEVELS.filter((l) => {
    const due = end - l.days * DAY_MS;
    return due <= horizon && due >= g.activeSince.getTime();
  }).pop();
  return level ? { type: level.type, days: endNoticeDaysLeft(g.endsAt, now) } : null;
}
