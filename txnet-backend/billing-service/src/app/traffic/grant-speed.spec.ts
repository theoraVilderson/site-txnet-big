/**
 * An admin sets a Grant's speed cap (F-311-p, spec F-311). What would break
 * quietly here, and nowhere else:
 *
 *  - **a cap is only promised where it is enforced.** Every panel the Grant
 *    has a live config on must answer `per_client_rate_limit` yes; any that
 *    does not is `rate_limit_unsupported`, **named**, and nothing is written —
 *    never a cap recorded that three of four panels ignore;
 *  - **lifting a cap is never refused** by a panel's answer: no cap is what
 *    every panel already enforces;
 *  - **one row per Grant**: a second cap replaces the first, and the answer
 *    says what it was;
 *  - a closed Grant is `grant_closed`, a pending one `grant_not_active`, and
 *    a Grant with no live config `no_configs` — nothing to hold the cap yet.
 */
import { DesiredRemote, GrantStatus } from '@prisma/client';

import { EntitlementRefused } from '../entitlement/grant';
import { setGrantSpeed, SpeedCapRefused } from './grant-speed';

const GRANT = '99999999-9999-4999-8999-999999999991';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const AT = new Date('2026-09-28T10:00:00.000Z');

type Panel = { id: string; name: string; transport: string; capabilities: unknown };

const answered = (rate: boolean) => ({ version: 1, answers: { per_client_rate_limit: { supported: rate } } });
const ROUTER: Panel = { id: 'p-router', name: 'Tehran router', transport: 'push', capabilities: answered(true) };
const XUI: Panel = { id: 'p-xui', name: 'Frankfurt x-ui', transport: 'pull', capabilities: answered(false) };
const UNTESTED: Panel = { id: 'p-new', name: 'Untested', transport: 'pull', capabilities: null };

function build(status: GrantStatus, panels: Panel[], cap?: number) {
  const rows = new Map<string, { grantId: string; rateMbps: number; reason: string; setByAdminId: string; setAt: Date }>();
  if (cap !== undefined) rows.set(GRANT, { grantId: GRANT, rateMbps: cap, reason: 'before', setByAdminId: ADMIN, setAt: AT });
  const configWhere: unknown[] = [];
  const tx = {
    grant: { findUnique: vi.fn(async () => ({ id: GRANT, status })) },
    config: {
      findMany: vi.fn(async (args: { where: unknown }) => {
        configWhere.push(args.where);
        return panels.map((panel) => ({ panel }));
      }),
    },
    grantRateLimit: {
      findUnique: vi.fn(async () => rows.get(GRANT) ?? null),
      upsert: vi.fn(async ({ create, update }: { create: { rateMbps: number }; update: { rateMbps: number } }) => {
        const row = { ...(rows.get(GRANT) ?? create), ...(rows.has(GRANT) ? update : {}) } as never;
        rows.set(GRANT, row);
        return row;
      }),
      deleteMany: vi.fn(async () => ({ count: rows.delete(GRANT) ? 1 : 0 })),
    },
  };
  return { tx: tx as never, rows, configWhere };
}

const input = (mbps: number | null) => ({ mbps, reason: 'abuse report', actorUserId: ADMIN, at: AT });

describe('setGrantSpeed (F-311-p)', () => {
  it('writes the cap when every live config sits on a panel that holds one', async () => {
    const { tx, rows, configWhere } = build(GrantStatus.active, [ROUTER, ROUTER]);
    const done = await setGrantSpeed(tx, GRANT, input(20));
    expect(done).toEqual({ grantId: GRANT, rateMbpsBefore: null, rateMbpsAfter: 20 });
    expect(rows.get(GRANT)).toMatchObject({ rateMbps: 20, reason: 'abuse report', setByAdminId: ADMIN });
    expect(configWhere[0]).toEqual({ grantId: GRANT, desiredRemote: DesiredRemote.present });
  });

  it('refuses by name, and writes nothing, where any panel cannot hold a cap', async () => {
    const { tx, rows } = build(GrantStatus.active, [ROUTER, XUI, UNTESTED, XUI]);
    const refusal = await setGrantSpeed(tx, GRANT, input(20)).catch((e) => e);
    expect(refusal).toBeInstanceOf(SpeedCapRefused);
    expect(refusal.reason).toBe('rate_limit_unsupported');
    expect(refusal.panels).toEqual([
      { id: 'p-xui', name: 'Frankfurt x-ui' },
      { id: 'p-new', name: 'Untested' },
    ]);
    expect(rows.size).toBe(0);
  });

  it('replaces a cap and answers the one it replaced', async () => {
    const { tx, rows } = build(GrantStatus.suspended, [ROUTER], 50);
    expect(await setGrantSpeed(tx, GRANT, input(10))).toEqual({ grantId: GRANT, rateMbpsBefore: 50, rateMbpsAfter: 10 });
    expect(rows.get(GRANT)?.rateMbps).toBe(10);
  });

  it('lifts a cap on any panel, capable or not', async () => {
    const { tx, rows } = build(GrantStatus.active, [XUI], 50);
    expect(await setGrantSpeed(tx, GRANT, input(null))).toEqual({ grantId: GRANT, rateMbpsBefore: 50, rateMbpsAfter: null });
    expect(rows.size).toBe(0);
  });

  it('refuses a Grant with no live config: nothing to hold the cap yet', async () => {
    const { tx } = build(GrantStatus.active, []);
    await expect(setGrantSpeed(tx, GRANT, input(20))).rejects.toMatchObject({ reason: 'no_configs' });
  });

  it.each([
    [GrantStatus.expired, 'grant_closed'],
    [GrantStatus.cancelled, 'grant_closed'],
    [GrantStatus.pending, 'grant_not_active'],
  ])('refuses a %s Grant as %s', async (status, reason) => {
    const { tx } = build(status, [ROUTER]);
    const refusal = await setGrantSpeed(tx, GRANT, input(20)).catch((e) => e);
    expect(refusal).toBeInstanceOf(EntitlementRefused);
    expect(refusal.reason).toBe(reason);
  });
});
