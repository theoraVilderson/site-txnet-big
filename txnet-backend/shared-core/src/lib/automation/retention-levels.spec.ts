/**
 * Retention levels and the 24 h hold (F-601-e, F-601-n). The time levels are
 * 7, 3 and 1 day(s) before a Grant's end; the usage levels 50, 80 and 95 % of
 * its period. A non-urgent one waits up to 24 h for the other kind, so two due
 * the same day reach the user as one message, and none is told early.
 *
 * What would break silently here, and nowhere else:
 *  - **never early**: a time level is due at its instant, not before — the
 *    hold only ever makes a notice later, and its text is computed when told;
 *  - **urgent is never held**: 95 % and the last day are told at once, taking
 *    a held one of the other kind with them;
 *  - **both kinds known means one message now**: there is nothing left to
 *    wait for once a usage and a time level are both due.
 */
import { OutboxEventType } from './routing-keys';
import { endNoticeStep, heldUsageNotice, remainingLabel, retentionToTell } from './retention-levels';

const DAY = 86_400_000;
const END = new Date('2026-10-27T10:00:00.000Z');
const ACTIVE = new Date('2026-09-27T10:00:00.000Z');
const before = (days: number) => new Date(END.getTime() - days * DAY);
const after = (at: Date, hours: number) => new Date(at.getTime() + hours * 3_600_000);

describe('endNoticeStep (F-601-e)', () => {
  const fresh = { endsAt: END, endSetAt: ACTIVE, activeSince: ACTIVE, endNoticeFor: null, endNoticeAt: null };
  const told = (next: Date | null) => ({ ...fresh, endNoticeFor: END, endNoticeAt: next });

  it('is due at 7, then 3, then 1 day(s), naming the instant each fell due', () => {
    expect(endNoticeStep(fresh, before(7))).toEqual({
      notice: { type: OutboxEventType.GRANT_ENDS_IN_7D, days: 7, dueAt: before(7) },
      next: before(3),
    });
    expect(endNoticeStep(told(before(3)), before(3))).toEqual({
      notice: { type: OutboxEventType.GRANT_ENDS_IN_3D, days: 3, dueAt: before(3) },
      next: before(1),
    });
    expect(endNoticeStep(told(before(1)), before(1))).toEqual({
      notice: { type: OutboxEventType.GRANT_ENDS_IN_1D, days: 1, dueAt: before(1) },
      next: null,
    });
  });

  it('is never due before its level — no time notice is early', () => {
    expect(endNoticeStep(fresh, after(before(7), -1))).toEqual({ notice: null, next: before(7) });
    expect(endNoticeStep(told(before(3)), after(before(3), -1))).toEqual({ notice: null, next: before(3) });
  });

  it('late past two levels, the lower alone with the days actually left', () => {
    expect(endNoticeStep(fresh, before(2.5))).toEqual({
      notice: { type: OutboxEventType.GRANT_ENDS_IN_3D, days: 3, dueAt: before(3) },
      next: before(1),
    });
  });

  it('a level told for this end is not due again; one before activation never is', () => {
    expect(endNoticeStep(told(before(3)), before(5))).toEqual({ notice: null, next: before(3) });
    expect(endNoticeStep(told(null), before(0.5))).toEqual({ notice: null, next: null });
    expect(endNoticeStep({ ...fresh, activeSince: before(5) }, before(5))).toEqual({ notice: null, next: before(3) });
  });

  it('a renewed end starts over; a passed end is due nothing', () => {
    const later = new Date(END.getTime() + 30 * DAY);
    expect(endNoticeStep({ ...fresh, endsAt: later, endNoticeFor: END }, new Date(later.getTime() - 7 * DAY))?.notice?.type).toBe(
      OutboxEventType.GRANT_ENDS_IN_7D,
    );
    expect(endNoticeStep(fresh, END)).toEqual({ notice: null, next: null });
  });
});

describe('endNoticeStep — only news (F-601-r, ADR-0097)', () => {
  const HOUR = 3_600_000;
  // A Grant whose end was set `span` ms before END, active since then, never checked.
  type Checked = Parameters<typeof endNoticeStep>[0];
  const spanOf = (span: number): Checked => {
    const set = new Date(END.getTime() - span);
    return { endsAt: END, endSetAt: set, activeSince: set, endNoticeFor: null, endNoticeAt: null };
  };
  // Every notice a sweep running each hour over the whole span would tell, as ms before the end.
  const toldOver = (span: number) => {
    const out: Array<{ type: string; before: number }> = [];
    let g = spanOf(span);
    for (let t = END.getTime() - span; t < END.getTime(); t += HOUR / 4) {
      const step = endNoticeStep(g, new Date(t));
      if (step.notice) out.push({ type: step.notice.type, before: END.getTime() - step.notice.dueAt.getTime() });
      g = { ...g, endNoticeFor: END, endNoticeAt: step.next };
      if (step.next === null) break;
    }
    return out;
  };
  const { GRANT_ENDS_IN_7D: D7, GRANT_ENDS_IN_3D: D3, GRANT_ENDS_IN_1D: D1 } = OutboxEventType;

  it('tells a level only when it is at most half the span — the ADR table', () => {
    expect(toldOver(1 * DAY)).toEqual([{ type: D1, before: 6 * HOUR }]);
    for (const days of [2, 5]) expect(toldOver(days * DAY)).toEqual([{ type: D1, before: DAY }]);
    for (const days of [6, 13]) expect(toldOver(days * DAY)).toEqual([{ type: D3, before: 3 * DAY }, { type: D1, before: DAY }]);
    for (const days of [14, 30]) {
      expect(toldOver(days * DAY)).toEqual([{ type: D7, before: 7 * DAY }, { type: D3, before: 3 * DAY }, { type: D1, before: DAY }]);
    }
  });

  it('never tells an N-day service its own length at activation', () => {
    for (const days of [7, 3, 1]) expect(endNoticeStep(spanOf(days * DAY), new Date(END.getTime() - days * DAY)).notice).toBeNull();
  });

  it('a span under 2 days gets one last call at a quarter of it; under 6 h, none', () => {
    expect(toldOver(40 * HOUR)).toEqual([{ type: D1, before: 10 * HOUR }]);
    expect(toldOver(6 * HOUR)).toEqual([{ type: D1, before: 1.5 * HOUR }]);
    expect(toldOver(6 * HOUR - 1)).toEqual([]);
    expect(endNoticeStep(spanOf(5 * HOUR), new Date(END.getTime() - 5 * HOUR))).toEqual({ notice: null, next: null });
  });

  it('a renewal counts its span from when it moved the end', () => {
    // A 30-day service renewed by 8 days with 1 day left: 9 days to go, so 3 and 1 — not 7 the next day.
    const renewedAt = new Date(END.getTime() - 9 * DAY);
    const g = { endsAt: END, endSetAt: renewedAt, activeSince: new Date(END.getTime() - 40 * DAY), endNoticeFor: null, endNoticeAt: null };
    expect(endNoticeStep(g, after(renewedAt, 24))).toEqual({ notice: null, next: before(3) });
  });
});

describe('retentionToTell (F-601-n)', () => {
  const seven = { type: OutboxEventType.GRANT_ENDS_IN_7D, days: 7, dueAt: before(7) };
  const lastDay = { type: OutboxEventType.GRANT_ENDS_IN_1D, days: 1, dueAt: before(1) };
  const eighty = (since: Date) => ({ level: 80 as const, since });
  const nothing = { usage: false, time: false };

  it('holds a lone non-urgent level for 24 h, then tells it alone', () => {
    expect(retentionToTell({ time: seven, usage: null }, after(before(7), 23))).toEqual(nothing);
    expect(retentionToTell({ time: seven, usage: null }, after(before(7), 24))).toEqual({ usage: false, time: true });
    const crossed = before(10);
    expect(retentionToTell({ time: null, usage: eighty(crossed) }, after(crossed, 23))).toEqual(nothing);
    expect(retentionToTell({ time: null, usage: eighty(crossed) }, after(crossed, 24))).toEqual({ usage: true, time: false });
  });

  it('tells both at once when both are due — the time level first, the usage level hours later', () => {
    expect(retentionToTell({ time: seven, usage: eighty(after(before(7), 6)) }, after(before(7), 6))).toEqual({ usage: true, time: true });
  });

  it('never holds 95 % or the last day, and takes a held one of the other kind along', () => {
    expect(retentionToTell({ time: null, usage: { level: 95, since: before(2) } }, before(2))).toEqual({ usage: true, time: false });
    expect(retentionToTell({ time: lastDay, usage: null }, before(1))).toEqual({ usage: false, time: true });
    expect(retentionToTell({ time: lastDay, usage: eighty(before(1.2)) }, before(1))).toEqual({ usage: true, time: true });
    expect(retentionToTell({ time: seven, usage: { level: 95, since: before(7) } }, before(7))).toEqual({ usage: true, time: true });
  });

  it('tells nothing when nothing is due', () => {
    expect(retentionToTell({ time: null, usage: null }, before(3))).toEqual(nothing);
  });
});

describe('remainingLabel (F-601-d)', () => {
  it('says what is left in whole GB, one decimal under 10 GB, whole MB under 1 GB', () => {
    expect(remainingLabel(BigInt(12) * BigInt(1024 ** 3))).toBe('12 GB');
    expect(remainingLabel(BigInt(Math.round(5.35 * 1024 ** 3)))).toBe('5.3 GB');
    expect(remainingLabel(BigInt(10))).toBe('1 MB');
  });
});

describe('heldUsageNotice (F-601-n)', () => {
  const period = new Date('2026-09-20T00:00:00.000Z');
  it('reads a held level of the current period, and drops one from before a renewal', () => {
    expect(heldUsageNotice({ usageNoticeLevel: 80, usageNoticeSince: new Date('2026-09-21T00:00:00.000Z'), usagePeriod: period })).toEqual({
      level: 80,
      since: new Date('2026-09-21T00:00:00.000Z'),
    });
    expect(heldUsageNotice({ usageNoticeLevel: 80, usageNoticeSince: new Date('2026-09-19T00:00:00.000Z'), usagePeriod: period })).toBeNull();
    expect(heldUsageNotice({ usageNoticeLevel: null, usageNoticeSince: null, usagePeriod: period })).toBeNull();
  });
});
