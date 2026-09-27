/**
 * The time level a usage notice carries (F-601-f): a usage and a time
 * threshold due within the same 24 h reach the user as one message, so the
 * charge that crosses a usage level names the time level due within the next
 * 24 h, and the ledger holds both rows for that one event.
 *
 * What would break silently here, and nowhere else:
 *  - **the nearest level alone**, as a late sweep tells it — a Grant 1.5 days
 *    from its end is at its 1-day level, not the 3-day one that already passed;
 *  - **never a level due before activation** — the sweep passes those untold,
 *    and a look-ahead that claimed one would tell what the sweep never would;
 *  - **the days actually left**, rounded up as the sweep rounds them.
 */
import { OutboxEventType } from './routing-keys';
import { endNoticeAhead } from './end-notice-levels';

const DAY = 86_400_000;
const NOW = new Date('2026-09-27T12:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const LONG_AGO = at(-30 * DAY);

describe('endNoticeAhead', () => {
  it('names the level due within the next 24 h, with the whole days left', () => {
    // 3.5 days left: the 3-day level falls due in 12 h.
    expect(endNoticeAhead({ endsAt: at(3.5 * DAY), activeSince: LONG_AGO }, NOW)).toEqual({ type: OutboxEventType.GRANT_ENDS_IN_3D, days: 4 });
  });

  it('names none when the next level is more than 24 h away', () => {
    // 5 days left, active for a day: the 7-day level was before it, the 3-day one is 2 days away.
    expect(endNoticeAhead({ endsAt: at(5 * DAY), activeSince: at(-1 * DAY) }, NOW)).toBeNull();
  });

  it('names the nearest level when two are within reach', () => {
    expect(endNoticeAhead({ endsAt: at(1.5 * DAY), activeSince: LONG_AGO }, NOW)).toEqual({ type: OutboxEventType.GRANT_ENDS_IN_1D, days: 2 });
    expect(endNoticeAhead({ endsAt: at(0.5 * DAY), activeSince: LONG_AGO }, NOW)).toEqual({ type: OutboxEventType.GRANT_ENDS_IN_1D, days: 1 });
  });

  it('names a level that fell due before now but after activation — the sweep may not have told it yet', () => {
    expect(endNoticeAhead({ endsAt: at(6.9 * DAY), activeSince: LONG_AGO }, NOW)).toEqual({ type: OutboxEventType.GRANT_ENDS_IN_7D, days: 7 });
  });

  it('never names a level that fell due before the Grant was active', () => {
    // A 5-day Grant bought a day ago: the 7-day level was before it; the 3-day one is a day away.
    expect(endNoticeAhead({ endsAt: at(4 * DAY), activeSince: at(-1 * DAY) }, NOW)).toEqual({ type: OutboxEventType.GRANT_ENDS_IN_3D, days: 4 });
    expect(endNoticeAhead({ endsAt: at(4.5 * DAY), activeSince: at(-0.5 * DAY) }, NOW)).toBeNull();
  });

  it('names none for an end already passed', () => {
    expect(endNoticeAhead({ endsAt: at(-1), activeSince: LONG_AGO }, NOW)).toBeNull();
  });
});
