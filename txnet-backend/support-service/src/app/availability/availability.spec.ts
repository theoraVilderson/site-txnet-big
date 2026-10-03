/**
 * Live or async (F-033-g, catalog §11.2): a conversation is `live` only while
 * at least one agent is online **and** the tenant is inside its working hours,
 * on its own wall clock.
 *
 * What would break silently:
 *  - the hours read in UTC instead of the tenant's zone — Tehran is +3:30, so
 *    "09:00" would open at 12:30;
 *  - a lapsed heartbeat still counted, so a thread opens `live` with no one there;
 *  - Redis down turning into a 500 on opening a conversation, instead of `async`;
 *  - the working-minute arithmetic SLA (F-033-h) counts in skipping a weekend
 *    wrongly.
 */
import { ConversationRefused } from '../conversations/conversations.service';
import { PresenceRedis, SupportAvailability, intervalsFrom } from './availability';
import { WorkingHours, addWorkingMinutes, nextOpening, withinHours, workingMsBetween } from './working-hours';

const TEHRAN = 'Asia/Tehran';
const TENANT = '11111111-1111-4111-8111-111111111111';
const SARA = '44444444-4444-4444-8444-4444444444a1';

/** Saturday … Wednesday, 09:00–17:00 Tehran (weekday 6, 0, 1, 2, 3). */
const OFFICE: WorkingHours = {
  zone: TEHRAN,
  intervals: [6, 0, 1, 2, 3].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })),
};

/** A Tehran wall-clock instant (+03:30, no DST since 2022). */
const tehran = (iso: string) => new Date(`${iso}+03:30`);

describe('working hours on the tenant wall clock', () => {
  it('is open 09:00–17:00 Tehran, not UTC, and closed on Friday', () => {
    expect(withinHours(OFFICE, tehran('2026-10-03T09:00:00'))).toBe(true); // Saturday
    expect(withinHours(OFFICE, tehran('2026-10-03T08:59:00'))).toBe(false);
    expect(withinHours(OFFICE, tehran('2026-10-03T17:00:00'))).toBe(false);
    expect(withinHours(OFFICE, tehran('2026-10-09T12:00:00'))).toBe(false); // Friday
  });

  it('names the next opening: Friday night opens Saturday 09:00; open now is null', () => {
    expect(nextOpening(OFFICE, tehran('2026-10-09T22:00:00'))).toEqual(tehran('2026-10-10T09:00:00'));
    expect(nextOpening(OFFICE, tehran('2026-10-07T18:00:00'))).toEqual(tehran('2026-10-10T09:00:00')); // Wednesday evening
    expect(nextOpening(OFFICE, tehran('2026-10-04T10:00:00'))).toBeNull();
  });

  it('treats no schedule as always open', () => {
    const none: WorkingHours = { zone: TEHRAN, intervals: [] };
    expect(withinHours(none, tehran('2026-10-09T03:00:00'))).toBe(true);
    expect(nextOpening(none, tehran('2026-10-09T03:00:00'))).toBeNull();
    expect(addWorkingMinutes(none, tehran('2026-10-09T03:00:00'), 60)).toEqual(tehran('2026-10-09T04:00:00'));
  });

  it('joins an interval running past midnight into the next day', () => {
    const night: WorkingHours = {
      zone: TEHRAN,
      intervals: [
        { weekday: 6, startMinute: 1320, endMinute: 1440 },
        { weekday: 0, startMinute: 0, endMinute: 120 },
      ],
    };
    expect(withinHours(night, tehran('2026-10-04T01:00:00'))).toBe(true);
    // 3 working hours from Saturday 22:00 run straight through midnight.
    expect(addWorkingMinutes(night, tehran('2026-10-03T22:00:00'), 180)).toEqual(tehran('2026-10-04T01:00:00'));
  });

  it('counts working minutes only (F-033-h): a 4h target on Friday 22:00 lands Saturday 13:00', () => {
    expect(addWorkingMinutes(OFFICE, tehran('2026-10-09T22:00:00'), 240)).toEqual(tehran('2026-10-10T13:00:00'));
    // 16:00 Wednesday + 2h = 1h Wednesday + 1h Saturday.
    expect(addWorkingMinutes(OFFICE, tehran('2026-10-07T16:00:00'), 120)).toEqual(tehran('2026-10-10T10:00:00'));
    expect(workingMsBetween(OFFICE, tehran('2026-10-07T16:00:00'), tehran('2026-10-10T10:00:00'))).toBe(2 * 3600_000);
    expect(workingMsBetween(OFFICE, tehran('2026-10-08T10:00:00'), tehran('2026-10-09T23:00:00'))).toBe(0);
  });
});

describe('the schedule an admin writes', () => {
  it('reads HH:MM, allows 24:00 as an end, and refuses an overlap on one day', () => {
    expect(intervalsFrom([{ weekday: 6, start: '09:00', end: '24:00' }])).toEqual([{ weekday: 6, startMinute: 540, endMinute: 1440 }]);
    const overlap = () =>
      intervalsFrom([
        { weekday: 1, start: '09:00', end: '13:00' },
        { weekday: 1, start: '12:00', end: '17:00' },
      ]);
    expect(overlap).toThrow(ConversationRefused);
    expect(() => intervalsFrom([{ weekday: 1, start: '13:00', end: '09:00' }])).toThrow(ConversationRefused);
  });
});

describe('live or async', () => {
  function fakeRedis() {
    const sets = new Map<string, Map<string, number>>();
    let down = false;
    const set = (key: string) => sets.get(key) ?? sets.set(key, new Map()).get(key)!;
    const guard = () => {
      if (down) throw new Error('redis down');
    };
    const redis: PresenceRedis = {
      zadd: async (key, score, member) => void (guard(), set(key).set(member, score)),
      zrem: async (key, member) => void (guard(), set(key).delete(member)),
      zremrangebyscore: async (key, max) => void (guard(), [...set(key)].forEach(([m, s]) => s <= max && set(key).delete(m))),
      zrangebyscore: async (key, min) => (guard(), [...set(key)].filter(([, s]) => s > min).map(([m]) => m)),
      expire: async () => guard(),
    };
    return { redis, goDown: () => (down = true) };
  }

  function availability(redis: PresenceRedis, hours: WorkingHours = OFFICE) {
    const a = new SupportAvailability({} as never, redis);
    vi.spyOn(a, 'hours').mockResolvedValue(hours);
    return a;
  }

  const saturdayNoon = tehran('2026-10-03T12:00:00');

  it('is live only with an agent online inside the hours', async () => {
    const { redis } = fakeRedis();
    const a = availability(redis);
    expect(await a.at(TENANT, saturdayNoon)).toMatchObject({ live: false, withinHours: true, agentsOnline: false, nextOpenAt: null });

    await a.beat({ tenantId: TENANT, userId: SARA }, 'online', saturdayNoon);
    expect(await a.at(TENANT, saturdayNoon)).toMatchObject({ live: true, agentsOnline: true });
    expect(await a.mode(TENANT, saturdayNoon)).toBe('live');

    // Online on a Friday is still outside the hours: async, with when it opens.
    const friday = tehran('2026-10-09T12:00:00');
    await a.beat({ tenantId: TENANT, userId: SARA }, 'online', friday);
    expect(await a.at(TENANT, friday)).toMatchObject({ live: false, nextOpenAt: tehran('2026-10-10T09:00:00') });
  });

  it('forgets an agent 90s after the last heartbeat, and at once on away', async () => {
    const { redis } = fakeRedis();
    const a = availability(redis);
    await a.beat({ tenantId: TENANT, userId: SARA }, 'online', saturdayNoon);
    expect(await a.online(TENANT, new Date(saturdayNoon.getTime() + 89_000))).toEqual([SARA]);
    expect(await a.online(TENANT, new Date(saturdayNoon.getTime() + 90_000))).toEqual([]);

    await a.beat({ tenantId: TENANT, userId: SARA }, 'online', saturdayNoon);
    await a.beat({ tenantId: TENANT, userId: SARA }, 'away', saturdayNoon);
    expect(await a.mode(TENANT, saturdayNoon)).toBe('async');
  });

  it('answers async, never an error, when Redis cannot', async () => {
    const { redis, goDown } = fakeRedis();
    const a = availability(redis);
    await a.beat({ tenantId: TENANT, userId: SARA }, 'online', saturdayNoon);
    goDown();
    expect(await a.mode(TENANT, saturdayNoon)).toBe('async');
  });
});
