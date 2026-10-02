/**
 * Quiet hours read the user's resolved zone (TZ-1-f, ADR-0108 point 6). What
 * would break silently here, and nowhere else:
 *
 *  - **a row with no zone of its own follows the resolver** — the user's
 *    zone, else the tenant's, else the platform's — read only when a window
 *    is set, so a mute-only row costs no lookup;
 *  - **a row that kept its zone keeps it**: an existing preference is never
 *    re-read through the resolver;
 *  - **null is a value the panel may save**, and a zone is stored canonical.
 */
import { NotificationPreferencesService } from './notification-preferences.service';
import { preferencesSchema } from './notification-preferences.schema';

const USER = '44444444-4444-4444-8444-444444444444';
const NIGHT = { mutedKinds: [] as string[], quietStart: 23 * 60, quietEnd: 8 * 60 };

function build(row: unknown, user: unknown = null) {
  const notificationPreference = { findUnique: vi.fn().mockResolvedValue(row), upsert: vi.fn(async ({ create }) => create) };
  const findUnique = vi.fn().mockResolvedValue(user);
  const service = new NotificationPreferencesService({ notificationPreference } as never, { user: { findUnique } } as never);
  return { service, findUnique, notificationPreference };
}

describe('NotificationPreferencesService.stored — the zone a claim reads quiet hours in', () => {
  it("reads a row with no zone in the user's own zone", async () => {
    const { service } = build({ ...NIGHT, timezone: null }, { timezone: 'Europe/Berlin', timezoneSource: 'browser', tenant: { timezone: 'Asia/Dubai' } });
    expect((await service.stored(USER))?.timezone).toBe('Europe/Berlin');
  });

  it("falls back to the tenant's zone, then the platform's", async () => {
    const tenant = build({ ...NIGHT, timezone: null }, { timezone: null, timezoneSource: null, tenant: { timezone: 'Asia/Dubai' } });
    expect((await tenant.service.stored(USER))?.timezone).toBe('Asia/Dubai');
    const none = build({ ...NIGHT, timezone: null }, null);
    expect((await none.service.stored(USER))?.timezone).toBe('Asia/Tehran');
  });

  it('keeps the zone an existing row was saved with, and reads no user for it', async () => {
    const { service, findUnique } = build({ ...NIGHT, timezone: 'America/Toronto' }, { timezone: 'Europe/Berlin', timezoneSource: 'user', tenant: null });
    expect((await service.stored(USER))?.timezone).toBe('America/Toronto');
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('reads no user for a row with no window, nor for no row', async () => {
    const muteOnly = build({ mutedKinds: ['usage'], quietStart: null, quietEnd: null, timezone: null });
    expect(await muteOnly.service.stored(USER)).toEqual({ mutedKinds: ['usage'], quietStart: null, quietEnd: null, timezone: null });
    expect(muteOnly.findUnique).not.toHaveBeenCalled();
    const none = build(null);
    expect(await none.service.stored(USER)).toBeNull();
    expect(none.findUnique).not.toHaveBeenCalled();
  });
});

describe('NotificationPreferencesService — null on the wire', () => {
  it('answers no row as null — the resolved zone — and saves null as null', async () => {
    expect((await build(null).service.get(USER)).timezone).toBeNull();
    const { service, notificationPreference } = build(null);
    const answer = await service.set(USER, { muted: [], quietHours: { start: '23:00', end: '08:00' }, timezone: null });
    expect(notificationPreference.upsert.mock.calls[0][0].create.timezone).toBeNull();
    expect(answer.timezone).toBeNull();
  });

  it('stores a zone canonical', async () => {
    const { service, notificationPreference } = build(null);
    await service.set(USER, { muted: [], quietHours: null, timezone: 'Iran' });
    expect(notificationPreference.upsert.mock.calls[0][0].create.timezone).toBe('Asia/Tehran');
  });

  it('takes null or an IANA zone, never an offset', () => {
    const body = { muted: [], quietHours: null };
    expect(preferencesSchema.safeParse({ ...body, timezone: null }).success).toBe(true);
    expect(preferencesSchema.safeParse({ ...body, timezone: 'Asia/Tehran' }).success).toBe(true);
    expect(preferencesSchema.safeParse({ ...body, timezone: '+03:30' }).success).toBe(false);
    expect(preferencesSchema.safeParse(body).success).toBe(false);
  });
});
