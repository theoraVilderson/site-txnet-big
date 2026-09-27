/**
 * A user mutes kinds of retention notice and sets quiet hours (F-601-m,
 * spec 9.4; invariant 15). What would break silently here, and nowhere else:
 *
 *  - **a stopped service is always told.** The cutoff notices (F-601-b) and
 *    the day before a purge (F-601-j) answer `now` whatever the user set;
 *  - **muted still claims.** The ledger row is written, so unmuting later
 *    never tells a period already past;
 *  - **quiet hours hold the bot, never the notice.** The claim answers
 *    `held` with the window's end in the user's own zone, a window may wrap
 *    midnight, and a row whose bot message is held stays `held` on a
 *    redelivery, so the bot is never told twice;
 *  - **a user writes only their own**, through the gate's `userId`, and the
 *    request's shape is strict.
 */
import { OutboxEventType } from '@txnet-backend/shared-core';

import { NotificationPreferencesService, quietUntil } from './notification-preferences.service';
import { preferencesSchema } from './notification-preferences.schema';
import { RetentionLedgerService } from './retention-ledger.service';

const USER = '44444444-4444-4444-8444-444444444444';
const GRANT = '99999999-9999-4999-8999-999999999991';
const EVENT = '88888888-8888-4888-8888-888888888888';
const TENANT = '11111111-1111-4111-8111-111111111111';

/** 23:00-08:00 in Tehran (UTC+03:30, no DST since 2022). */
const NIGHT = { quietStart: 23 * 60, quietEnd: 8 * 60, timezone: 'Asia/Tehran' };

describe('quietUntil', () => {
  it("answers the window's next end, on the minute, inside a window that wraps midnight", () => {
    // 02:15:40 in Tehran is 22:45:40 UTC the day before; 08:00 Tehran is 04:30 UTC.
    expect(quietUntil(NIGHT, new Date('2026-09-27T22:45:40Z'))?.toISOString()).toBe('2026-09-28T04:30:00.000Z');
    // 23:30 Tehran, before midnight: the same morning's end.
    expect(quietUntil(NIGHT, new Date('2026-09-27T20:00:00Z'))?.toISOString()).toBe('2026-09-28T04:30:00.000Z');
  });

  it('answers null outside the window, at its end, and with no window', () => {
    expect(quietUntil(NIGHT, new Date('2026-09-28T04:30:00Z'))).toBeNull();
    expect(quietUntil(NIGHT, new Date('2026-09-28T10:00:00Z'))).toBeNull();
    expect(quietUntil({ quietStart: null, quietEnd: null, timezone: 'Asia/Tehran' }, new Date())).toBeNull();
    expect(quietUntil(null, new Date())).toBeNull();
  });

  it('reads a window that does not wrap, in the zone it was set in', () => {
    const lunch = { quietStart: 13 * 60, quietEnd: 14 * 60, timezone: 'Europe/Berlin' };
    // 13:20 in Berlin (CEST, UTC+2) is 11:20 UTC.
    expect(quietUntil(lunch, new Date('2026-09-27T11:20:00Z'))?.toISOString()).toBe('2026-09-27T12:00:00.000Z');
    expect(quietUntil(lunch, new Date('2026-09-27T13:20:00Z'))).toBeNull();
  });
});

describe('RetentionLedgerService.claim — how a claimed notice is told', () => {
  const at = new Date('2026-09-27T22:45:40Z'); // 02:15 in Tehran
  const claim = (notice: string) => ({ eventId: EVENT, userId: USER, grantId: GRANT, notice, period: 'p1' });

  function ledger(stored: unknown, held: unknown = null) {
    const retentionNotice = {
      createMany: vi.fn().mockResolvedValue({ count: held ? 0 : 1 }),
      findUnique: vi.fn().mockResolvedValue(held),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(0),
    };
    const preferences = { stored: vi.fn().mockResolvedValue(stored) };
    return { retentionNotice, preferences, service: new RetentionLedgerService({ retentionNotice } as never, preferences as never) };
  }

  it('mutes a kind the user muted — and still writes the row', async () => {
    const { retentionNotice, service } = ledger({ mutedKinds: ['usage'], quietStart: null, quietEnd: null, timezone: 'Asia/Tehran' });

    await expect(service.claim(claim(OutboxEventType.GRANT_USAGE_80), at)).resolves.toEqual({ claimed: true, deliver: 'muted' });
    expect(retentionNotice.createMany).toHaveBeenCalled();
  });

  it('holds the bot until the quiet window ends, for a kind not muted', async () => {
    const { service } = ledger({ mutedKinds: ['usage'], ...NIGHT });

    await expect(service.claim(claim(OutboxEventType.GRANT_ENDS_IN_3D), at)).resolves.toEqual({
      claimed: true,
      deliver: 'held',
      botAt: '2026-09-28T04:30:00.000Z',
    });
  });

  it('tells a cutoff or purge notice now, whatever is muted and whatever the hour — without reading the preferences', async () => {
    for (const notice of [
      OutboxEventType.GRANT_ENDED,
      OutboxEventType.GRANT_VOLUME_SPENT,
      OutboxEventType.GRANT_WALLET_SPENT,
      OutboxEventType.GRANT_PURGE_SOON,
      OutboxEventType.GRANT_PURGE_SOON_METERED,
    ]) {
      const { preferences, service } = ledger({ mutedKinds: ['usage', 'ending', 'connect', 'reactivated'], ...NIGHT });
      await expect(service.claim(claim(notice), at), notice).resolves.toEqual({ claimed: true, deliver: 'now' });
      expect(preferences.stored).not.toHaveBeenCalled();
    }
  });

  it('answers a redelivery whose bot message is already held with that hold, even after the window', async () => {
    const botAt = new Date('2026-09-28T04:30:00Z');
    const { preferences, service } = ledger(null, { eventId: EVENT, botAt, botTemplate: 'serviceEndsSoon' });

    await expect(service.claim(claim(OutboxEventType.GRANT_ENDS_IN_3D), new Date('2026-09-28T09:00:00Z'))).resolves.toEqual({
      claimed: true,
      deliver: 'held',
      botAt: botAt.toISOString(),
    });
    expect(preferences.stored).not.toHaveBeenCalled();
  });

  it('keeps a bot message only on the row this event holds, never over one already kept', async () => {
    const { retentionNotice, service } = ledger(null);
    const hold = {
      eventId: EVENT,
      grantId: GRANT,
      notice: OutboxEventType.GRANT_ENDS_IN_3D,
      period: 'p1',
      tenantId: TENANT,
      template: 'serviceEndsSoon',
      params: { days: '3' },
      botAt: '2026-09-28T04:30:00.000Z',
    };

    await expect(service.hold(hold, at)).resolves.toEqual({ held: true });
    expect(retentionNotice.updateMany).toHaveBeenCalledWith({
      where: { grantId: GRANT, notice: hold.notice, period: 'p1', eventId: EVENT, botTemplate: null },
      data: { botTenantId: TENANT, botAt: new Date(hold.botAt), botTemplate: 'serviceEndsSoon', botParams: { days: '3' } },
    });
    await expect(service.hold({ ...hold, botAt: '2026-09-30T04:30:00.000Z' }, at)).rejects.toThrow(/more than a day/);
  });
});

describe('NotificationPreferencesService', () => {
  function service(row: unknown) {
    const notificationPreference = { findUnique: vi.fn().mockResolvedValue(row), upsert: vi.fn().mockResolvedValue(row) };
    return { notificationPreference, service: new NotificationPreferencesService({ notificationPreference } as never) };
  }

  it('reads no row as nothing muted, no quiet hours, Tehran', async () => {
    await expect(service(null).service.get(USER)).resolves.toEqual({ muted: [], quietHours: null, timezone: 'Asia/Tehran' });
  });

  it("writes the caller's own row, each kind once in the panel's order, the window as minutes", async () => {
    const stored = { mutedKinds: ['usage', 'connect'], quietStart: 1380, quietEnd: 480, timezone: 'Asia/Tehran' };
    const { notificationPreference, service: s } = service(stored);

    const answer = await s.set(USER, { muted: ['connect', 'usage', 'connect'], quietHours: { start: '23:00', end: '08:00' }, timezone: 'Asia/Tehran' });

    const data = { mutedKinds: ['usage', 'connect'], quietStart: 1380, quietEnd: 480, timezone: 'Asia/Tehran' };
    expect(notificationPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER }, create: { userId: USER, ...data }, update: data }),
    );
    expect(answer).toEqual({ muted: ['usage', 'connect'], quietHours: { start: '23:00', end: '08:00' }, timezone: 'Asia/Tehran' });
  });

  it('refuses cutoff as a mutable kind, an equal-ended window, a bad clock or zone, and an unknown key', () => {
    const ok = { muted: ['usage'], quietHours: { start: '23:00', end: '08:00' }, timezone: 'Asia/Tehran' };
    expect(preferencesSchema.safeParse(ok).success).toBe(true);
    expect(preferencesSchema.safeParse({ ...ok, quietHours: null }).success).toBe(true);
    expect(preferencesSchema.safeParse({ ...ok, muted: ['cutoff'] }).success).toBe(false);
    expect(preferencesSchema.safeParse({ ...ok, quietHours: { start: '08:00', end: '08:00' } }).success).toBe(false);
    expect(preferencesSchema.safeParse({ ...ok, quietHours: { start: '24:00', end: '08:00' } }).success).toBe(false);
    expect(preferencesSchema.safeParse({ ...ok, timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(preferencesSchema.safeParse({ ...ok, userId: USER }).success).toBe(false);
  });
});
