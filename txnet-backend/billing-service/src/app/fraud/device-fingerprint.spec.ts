/**
 * The device fingerprint (F-036-a, D-11, ADR-0111 point 3).
 *
 * What breaks silently here is the count a free grant is refused on: a recipe
 * that lets two places hash alike, a source read from something the client
 * can choose, or a window that counts an account seen two months ago. Each is
 * a spin wheel that either refuses the honest or admits the farm, and neither
 * shows up as an error.
 */
import { DEVICE_ID_COOKIE, IdentityHeaders } from '@txnet-backend/shared-core';
import { Prisma } from '@prisma/client';

import {
  FINGERPRINT_WINDOW_DAYS,
  accountsOnFingerprint,
  fingerprintHash,
  fingerprintSourceOf,
  fingerprintVerdict,
  recordFingerprint,
} from './device-fingerprint';

const TENANT = '00000000-0000-4000-8000-0000000000a1';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000a2';
const AT = new Date('2026-10-03T12:00:00Z');
const daysBefore = (days: number) => new Date(AT.getTime() - days * 86_400_000);

const web = { channel: 'web' as const, ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (X11)', deviceId: 'd-1' };
const bot = { channel: 'bot' as const, platform: 'telegram', platformUserId: '12345' };

type Row = { id: string; tenantId: string; userId: string; fingerprintHash: string; channel: string; firstSeenAt: Date; lastSeenAt: Date };

/** `deviceFingerprint` over an array, honouring the filters the module sends. */
function fakeTx(rows: Row[]) {
  const deviceFingerprint = {
    upsert: vi.fn(async ({ where, create, update }) => {
      const key = where.tenantId_userId_fingerprintHash;
      const hit = rows.find((r) => r.tenantId === key.tenantId && r.userId === key.userId && r.fingerprintHash === key.fingerprintHash);
      if (hit) return Object.assign(hit, update);
      const row = { id: `fp-${rows.length + 1}`, firstSeenAt: create.lastSeenAt, ...create } as Row;
      rows.push(row);
      return row;
    }),
    findMany: vi.fn(async ({ where, distinct }) => {
      const hits = rows.filter(
        (r) => r.tenantId === where.tenantId && r.fingerprintHash === where.fingerprintHash && r.lastSeenAt >= where.lastSeenAt.gte,
      );
      return distinct?.includes('userId') ? [...new Map(hits.map((r) => [r.userId, r])).values()] : hits;
    }),
  };
  return { deviceFingerprint } as unknown as Prisma.TransactionClient;
}

describe('the recipe (D-11)', () => {
  it('is stable for one place and changes with each web component', () => {
    expect(fingerprintHash(web)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintHash({ ...web })).toBe(fingerprintHash(web));
    expect(fingerprintHash({ ...web, ip: '203.0.113.8' })).not.toBe(fingerprintHash(web));
    expect(fingerprintHash({ ...web, userAgent: 'Other' })).not.toBe(fingerprintHash(web));
    expect(fingerprintHash({ ...web, deviceId: 'd-2' })).not.toBe(fingerprintHash(web));
  });

  it('keeps a messenger account one place, whatever network it is on', () => {
    expect(fingerprintHash({ ...bot })).toBe(fingerprintHash(bot));
    expect(fingerprintHash({ ...bot, platform: 'bale' })).not.toBe(fingerprintHash(bot));
  });

  it('never lets two components run into each other', () => {
    // A joined string would hash these alike: "a|b" + "c" and "a" + "b|c".
    expect(fingerprintHash({ ...web, ip: 'a|b', userAgent: 'c' })).not.toBe(fingerprintHash({ ...web, ip: 'a', userAgent: 'b|c' }));
    expect(fingerprintHash({ channel: 'bot', platform: 'telegram|1', platformUserId: '2' })).not.toBe(
      fingerprintHash({ channel: 'bot', platform: 'telegram', platformUserId: '1|2' }),
    );
  });
});

describe('the source of a request', () => {
  const browser = (cookie?: string) => ({
    ip: '203.0.113.7',
    headers: { 'user-agent': 'Mozilla/5.0 (X11)', ...(cookie ? { cookie } : {}) },
  });

  it('is the browser: its address, its agent and the server-minted device cookie', () => {
    expect(fingerprintSourceOf(browser(`a=1; ${DEVICE_ID_COOKIE}=d-1`))).toEqual(web);
  });

  it('is the messenger account the gate vouched for, not the address the bot calls from', () => {
    const req = {
      ip: '10.0.0.5',
      headers: {
        'user-agent': 'bot-service',
        [IdentityHeaders.chatPlatform.toLowerCase()]: 'telegram',
        [IdentityHeaders.chatUserId.toLowerCase()]: '12345',
      },
    };
    expect(fingerprintSourceOf(req)).toEqual(bot);
  });

  it('is none for a browser without the cookie — no fingerprint, so no free grant', () => {
    expect(fingerprintSourceOf(browser())).toBeNull();
    expect(fingerprintSourceOf({ ...browser(`${DEVICE_ID_COOKIE}=d-1`), ip: undefined })).toBeNull();
  });
});

describe('distinct accounts per fingerprint', () => {
  it('records one row per account and place, and moves its last sighting', async () => {
    const rows: Row[] = [];
    const tx = fakeTx(rows);
    const first = await recordFingerprint(tx, { tenantId: TENANT, userId: 'u1', source: web, at: daysBefore(3) });
    const again = await recordFingerprint(tx, { tenantId: TENANT, userId: 'u1', source: web, at: AT });
    expect(again.id).toBe(first.id);
    expect(again.fingerprintHash).toBe(fingerprintHash(web));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: TENANT, channel: 'web', lastSeenAt: AT });
  });

  it('counts accounts seen in the window, each once, in this tenant only', async () => {
    const hash = fingerprintHash(web);
    const row = (userId: string, tenantId: string, lastSeenAt: Date): Row => ({
      id: `${userId}-${tenantId}`, tenantId, userId, fingerprintHash: hash, channel: 'web', firstSeenAt: lastSeenAt, lastSeenAt,
    });
    const tx = fakeTx([
      row('u1', TENANT, AT),
      row('u2', TENANT, daysBefore(FINGERPRINT_WINDOW_DAYS)),
      row('u3', TENANT, daysBefore(FINGERPRINT_WINDOW_DAYS + 1)),
      row('u4', OTHER_TENANT, AT),
    ]);
    expect(await accountsOnFingerprint(tx, { tenantId: TENANT, fingerprintHash: hash, at: AT })).toBe(2);
  });

  it('flags at 3 accounts and refuses free grants at 5 (D-11)', () => {
    expect([1, 2, 3, 4, 5, 9].map(fingerprintVerdict)).toEqual(['clear', 'clear', 'flag', 'flag', 'refuse_free_grants', 'refuse_free_grants']);
  });
});
