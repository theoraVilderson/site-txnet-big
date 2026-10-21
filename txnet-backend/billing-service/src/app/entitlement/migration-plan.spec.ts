import { ConfigProtocol, DriverType, GrantSource } from '@prisma/client';

import { planMigrationItem, remoteIdentityOf, sourceClientSchema } from './migration-plan';

/**
 * F-202 (D-63): one source client, as network-service read it (F-201-b), to
 * what an import would issue — whatever family it came from. What fails
 * silently here: an expired client imported as a live service, an unlimited
 * one imported with a 0-byte bag (dead on arrival), a client the source
 * disabled imported as enabled, usage that resets to zero, a protocol we do
 * not sell provisioned anyway, and a key that differs between two runs of the
 * same panel (every user imported twice).
 */
const NOW = new Date('2026-10-21T12:00:00Z');
const GIB = 1024 ** 3;
const SOURCE = { family: DriverType.marzban, sourceAddress: 'https://old.example:8443', panelId: 'panel-1', now: NOW };

/** Each family's client shape as the snapshot answers it (contract.source.md). */
const FAMILY_CLIENTS = {
  marzban: { remoteId: 'ali', label: 'ali', uuid: '7d0f…', inboundRemoteId: 'VLESS TCP', protocol: 'vless', enabled: true, dataLimitBytes: 50 * GIB, upBytes: 2 * GIB, downBytes: 8 * GIB, expiresAt: '2026-11-20T12:00:00Z', lines: ['vless://…'], linesRead: true },
  three_x_ui: { remoteId: 'ali@3x', label: 'ali@3x', uuid: '1b2c…', inboundRemoteId: '3', protocol: 'vmess', enabled: false, dataLimitBytes: 0, upBytes: 0, downBytes: 0, expiresAt: null, lines: [], linesRead: false },
  s_ui: { remoteId: 'reza', label: 'reza', uuid: '', inboundRemoteId: '1', protocol: 'hysteria2', enabled: true, dataLimitBytes: 10 * GIB, upBytes: 1, downBytes: 2, expiresAt: '2026-10-22T00:00:00.123456789+03:30', lines: [], linesRead: false },
  hiddify: { remoteId: '5f9e…', label: 'Sara', uuid: '5f9e…', inboundRemoteId: 'all', protocol: 'trojan', enabled: true, dataLimitBytes: 30 * GIB, upBytes: 0, downBytes: GIB, expiresAt: '2026-12-01T00:00:00Z', lines: [], linesRead: false },
};

const plan = (raw: unknown, over: Partial<typeof SOURCE> = {}) => planMigrationItem(sourceClientSchema.parse(raw), { ...SOURCE, ...over });

describe('planMigrationItem', () => {
  it.each(Object.entries(FAMILY_CLIENTS))('plans a %s client', (_family, raw) => {
    const p = plan(raw);
    expect(p.skipReason).toBeUndefined();
  });

  it('plans a user, a migration Grant with its quota, usage and end, and a config on the chosen panel', () => {
    expect(plan(FAMILY_CLIENTS.marzban)).toEqual({
      remoteIdentity: 'marzban|https://old.example:8443|ali',
      user: { label: 'ali' },
      grant: {
        source: GrantSource.migration,
        startsAt: NOW,
        endsAt: new Date('2026-11-20T12:00:00Z'),
        trafficUnlimited: false,
        purchasedBytes: BigInt(50 * GIB),
        consumedBytes: BigInt(10 * GIB),
      },
      config: { panelId: 'panel-1', protocol: ConfigProtocol.vless, uuid: '7d0f…' },
      enabled: true,
    });
  });

  it('keeps an unlimited client unlimited, with no end and its disabled state', () => {
    const p = plan(FAMILY_CLIENTS.three_x_ui);
    expect(p.grant).toMatchObject({ trafficUnlimited: true, purchasedBytes: BigInt(0), endsAt: null });
    expect(p.enabled).toBe(false);
  });

  it('reads an end given with an offset, and leaves an unread uuid for the link batch', () => {
    const p = plan(FAMILY_CLIENTS.s_ui);
    expect(p.grant?.endsAt).toEqual(new Date('2026-10-21T20:30:00.123Z'));
    expect(p.config?.uuid).toBeNull();
  });

  it('skips a client whose end has passed', () => {
    expect(plan({ ...FAMILY_CLIENTS.marzban, expiresAt: '2026-10-21T12:00:00Z' })).toEqual({ remoteIdentity: 'marzban|https://old.example:8443|ali', skipReason: 'expired' });
  });

  it.each(['naive', 'shadowtls', 'VLESS ', 'socks', ''])('skips protocol %j as unknown_protocol', (protocol) => {
    const p = plan({ ...FAMILY_CLIENTS.marzban, protocol });
    expect(p.skipReason).toBe(protocol.trim().toLowerCase() === 'vless' ? undefined : 'unknown_protocol');
  });

  it('names the source client the same way on every run, and apart on another panel', () => {
    expect(remoteIdentityOf(SOURCE, 'ali')).toBe(plan(FAMILY_CLIENTS.marzban).remoteIdentity);
    expect(plan(FAMILY_CLIENTS.marzban, { sourceAddress: 'https://other.example' }).remoteIdentity).not.toBe(plan(FAMILY_CLIENTS.marzban).remoteIdentity);
  });

  it('falls back to the remote id for a blank label', () => {
    expect(plan({ ...FAMILY_CLIENTS.marzban, label: '  ' }).user).toEqual({ label: 'ali' });
  });
});

describe('sourceClientSchema', () => {
  it.each([
    ['negative usage', { upBytes: -1 }],
    ['a fractional limit', { dataLimitBytes: 1.5 }],
    ['an end that is no time', { expiresAt: 'soon' }],
    ['no remote id', { remoteId: '' }],
  ])('refuses %s from the source', (_what, bad) => {
    expect(sourceClientSchema.safeParse({ ...FAMILY_CLIENTS.marzban, ...bad }).success).toBe(false);
  });
});
