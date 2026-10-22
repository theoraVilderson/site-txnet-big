import { MigrationItemAction } from '@prisma/client';

import { correctedClientOf, linkClientOf, linkIdentityOf, planLinkRun, type LinkPlanContext } from './migration-link';

/**
 * F-201-g (D-63): one user's import from an old subscription link. What fails
 * silently here: a link read twice keyed apart (a second Grant for the same
 * old service), a header's "not given" read as a date or a quota, an admin's
 * correction overwriting what the link said (so nobody can see what was
 * claimed), a link already imported with its panel imported again, and an
 * unlimited claim landing on a limited product.
 */
const NOW = new Date('2026-10-22T12:00:00Z');
const GIB = 1024 ** 3;
const URL_ = 'https://old.example.com:2096/sub/Ab12Cd34';
const IN_TEN_DAYS = Math.floor(NOW.getTime() / 1000) + 10 * 86_400;

const read = (over: Partial<{ uploadBytes: number; downloadBytes: number; totalBytes: number; expiresAt: number }> = {}, lines = ['vless://uuid@a.example:443#a']) => ({
  userinfo: { uploadBytes: GIB, downloadBytes: 4 * GIB, totalBytes: 20 * GIB, expiresAt: IN_TEN_DAYS, ...over },
  lines,
});

const ctx = (over: Partial<LinkPlanContext> = {}): LinkPlanContext => ({ now: NOW, variantUnlimited: false, held: false, oldLinkTaken: false, ...over });

describe('linkIdentityOf', () => {
  it('is the same key for the same link however it is written, and apart from another', () => {
    expect(linkIdentityOf(URL_)).toBe(linkIdentityOf(`${URL_}/`));
    expect(linkIdentityOf(URL_)).not.toBe(linkIdentityOf('https://old.example.com:2096/sub/Zz99'));
    expect(linkIdentityOf(URL_)).toMatch(/^link\|https:\/\/old\.example\.com:2096\|[0-9a-f]{64}$/);
  });

  it('never carries the old token itself', () => {
    expect(linkIdentityOf(URL_)).not.toContain('Ab12Cd34');
  });
});

describe('linkClientOf', () => {
  it('reads the four figures of Subscription-Userinfo, the protocol of the first line we sell, and keeps the link', () => {
    const client = linkClientOf(URL_, read({}, ['naive+https://x', 'ss://abc@b.example:8388#b', 'vless://u@a:443']));
    expect(client).toMatchObject({ dataLimitBytes: 20 * GIB, upBytes: GIB, downBytes: 4 * GIB, protocol: 'shadowsocks', enabled: true, subscriptionUrl: URL_, label: 'old.example.com', lines: [] });
    expect(client.expiresAt).toEqual(new Date(IN_TEN_DAYS * 1000));
  });

  it('reads an expire of 0 as no end, never 1970', () => {
    expect(linkClientOf(URL_, read({ expiresAt: 0 })).expiresAt).toBeNull();
  });

  it('answers no protocol for a link carrying no line we sell', () => {
    expect(linkClientOf(URL_, read({}, [])).protocol).toBe('');
  });
});

describe('correctedClientOf', () => {
  const client = linkClientOf(URL_, read({ totalBytes: 0, expiresAt: 0 }));

  it('lays the admin figures over what was read, and leaves what they did not touch', () => {
    const at = new Date('2026-11-01T00:00:00Z');
    const corrected = correctedClientOf(client, { dataLimitBytes: BigInt(30 * GIB), usedBytes: null, expiresAt: at });
    expect(corrected).toMatchObject({ dataLimitBytes: 30 * GIB, upBytes: GIB, downBytes: 4 * GIB, expiresAt: at });
  });

  it('puts a corrected usage in one figure, so used is exactly what the admin entered', () => {
    const corrected = correctedClientOf(client, { dataLimitBytes: null, usedBytes: BigInt(2 * GIB), expiresAt: null });
    expect(corrected.upBytes + corrected.downBytes).toBe(2 * GIB);
  });

  it('never edits the client it was given (the snapshot stays what the link said)', () => {
    correctedClientOf(client, { dataLimitBytes: BigInt(1), usedBytes: BigInt(1), expiresAt: NOW });
    expect(client.dataLimitBytes).toBe(0);
  });
});

describe('planLinkRun', () => {
  const client = linkClientOf(URL_, read());
  const key = linkIdentityOf(URL_);
  const only = (plan: ReturnType<typeof planLinkRun>) => {
    expect(plan.items).toHaveLength(1);
    return plan.items[0];
  };

  it('plans one create, its snapshot what was read', () => {
    const plan = planLinkRun(client, key, ctx());
    expect(only(plan)).toMatchObject({ remoteIdentity: key, plannedAction: MigrationItemAction.create, skipReason: null, sourceSnapshot: expect.objectContaining({ dataLimitBytes: 20 * GIB }) });
    expect(plan).toMatchObject({ plannedCreate: 1, plannedUpdate: 0, plannedSkip: 0 });
  });

  it('plans a create before any product is chosen: the commit waits for one', () => {
    expect(only(planLinkRun(client, key, ctx({ variantUnlimited: null }))).plannedAction).toBe(MigrationItemAction.create);
  });

  it('is an update when the tenant already holds a Grant of this link', () => {
    expect(only(planLinkRun(client, key, ctx({ held: true }))).plannedAction).toBe(MigrationItemAction.update);
  });

  it('skips a link a panel import already brought (its old path is another Grant)', () => {
    expect(only(planLinkRun(client, key, ctx({ oldLinkTaken: true })))).toMatchObject({ plannedAction: MigrationItemAction.skip, skipReason: 'duplicate' });
  });

  it('skips an end already passed and a link carrying nothing we sell', () => {
    const ended = linkClientOf(URL_, read({ expiresAt: Math.floor(NOW.getTime() / 1000) - 60 }));
    expect(only(planLinkRun(ended, key, ctx())).skipReason).toBe('expired');
    expect(only(planLinkRun(linkClientOf(URL_, read({}, [])), key, ctx())).skipReason).toBe('unknown_protocol');
  });

  it('skips an unlimited claim on a limited product, and the reverse', () => {
    const unlimited = linkClientOf(URL_, read({ totalBytes: 0 }));
    expect(only(planLinkRun(unlimited, key, ctx({ variantUnlimited: false }))).skipReason).toBe('traffic_mismatch');
    expect(only(planLinkRun(client, key, ctx({ variantUnlimited: true }))).skipReason).toBe('traffic_mismatch');
  });
});
