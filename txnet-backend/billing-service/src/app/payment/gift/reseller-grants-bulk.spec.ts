/**
 * An admin acts on many users' Grants at once (F-311-u, spec F-311): freeze,
 * unfreeze, days, traffic, reset, gift, speed, devices — 1..50 Grants of the
 * reseller the **path** names, one outcome per Grant. E.g. +3 days to everyone
 * after an outage.
 *
 * Each action is the single-Grant route's own function, unchanged. What this
 * surface adds, and each case below is a way it breaks quietly:
 *
 *  - **the door is `staffWrite`, once.** A suspended reseller acts on nothing,
 *    and a refusal reads no Grant;
 *  - **a Grant must be the reseller's** (C-15). There is no path user, so the
 *    fence is the Grant's own `tenantId`, read in its own transaction: another
 *    tenant's Grant is `grant_not_found` and is never acted on;
 *  - **one transaction per Grant, deduplicated, in order**, each written down
 *    (F-311-r) — a Grant named twice gets +3 days once, not +6;
 *  - **one Grant's refusal is its own outcome**; its neighbours still run, and
 *    a throw nobody named is `failed`, never the whole request's 500;
 *  - **one `requestId`, one act per Grant** (F-311-u1): a double click or a
 *    repeated bot callback answers the first call's outcomes — +3 days never
 *    becomes +6 — and the same id with another body is `request_reused`.
 */
import { Prisma } from '@prisma/client';
import { ResellerAccess, TenantContext } from '@txnet-backend/shared-core';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';

import { EntitlementRefused } from '../../entitlement/grant';
import { SpeedCapRefused } from '../../traffic/grant-speed';
import { GrantBulkBody, grantBulkSchema } from './grant-bulk.schema';
import { ResellerUserGrantsRefused, ResellerUserGrantsService } from './reseller-user-grants.service';

type Call = { fn: string; grantId: string; input?: unknown; scope: string | undefined };
const calls: Call[] = [];
const audits: { grantId: string | null; action: string; reason: string | null; tenantId: string }[] = [];
const scope = () => TenantContext.currentOrNull()?.id;
/** Grants whose act throws, and what. */
const throwing = new Map<string, Error>();

function step<T>(fn: string, grantId: string, input: unknown, result: T): Promise<T> {
  calls.push({ fn, grantId, input, scope: scope() });
  const e = throwing.get(grantId);
  return e ? Promise.reject(e) : Promise.resolve(result);
}

vi.mock('../../entitlement/freeze', () => ({
  freezeGrant: (_tx: unknown, id: string, input: unknown) => step('freeze', id, input, { frozenUntil: null, configsDisabled: 2 }),
  unfreezeGrant: (_tx: unknown, id: string) => step('unfreeze', id, null, { endsAt: new Date('2026-10-10T00:00:00Z'), configsRestored: 2 }),
}));
vi.mock('../../entitlement/duration', () => ({
  changeGrantDuration: (_tx: unknown, id: string, input: unknown) =>
    step('duration', id, input, { changeId: `chg-${id}`, endsAtBefore: new Date('2026-10-01T00:00:00Z'), endsAtAfter: new Date('2026-10-04T00:00:00Z'), revived: false }),
}));
const trafficResult = { adjustmentId: 'adj', purchasedBytesBefore: BigInt(10), purchasedBytesAfter: BigInt(20), usedBytes: BigInt(5), spent: false, revived: false };
vi.mock('../../entitlement/traffic', () => ({
  adjustGrantTraffic: (_tx: unknown, id: string, input: unknown) => step('traffic', id, input, trafficResult),
  resetGrantTraffic: (_tx: unknown, id: string, input: unknown) => step('reset', id, input, { ...trafficResult, resetBytes: BigInt(5) }),
}));
vi.mock('../../traffic/gift-bytes', async (real) => ({
  ...(await real<typeof import('../../traffic/gift-bytes')>()),
  giftGrantBytes: (_tx: unknown, id: string, input: unknown) => step('gift', id, input, trafficResult),
}));
vi.mock('../../traffic/grant-speed', async (orig) => ({
  ...(await orig<typeof import('../../traffic/grant-speed')>()),
  setGrantSpeed: (_tx: unknown, id: string, input: unknown) => step('speed', id, input, { grantId: id, rateMbpsBefore: null, rateMbpsAfter: 20 }),
}));
vi.mock('../../entitlement/devices', () => ({
  setGrantDeviceLimit: (_tx: unknown, id: string, input: unknown) =>
    step('devices', id, input, { grantId: id, adjustmentId: 'adj', limitBefore: null, limitAfter: 2, panelsNotEnforcing: [] }),
}));
vi.mock('../../grant-audit/grant-audit', () => ({
  auditedGrantAct: async (_tx: unknown, _actor: unknown, tenantId: string, grantId: string | null, spec: { action: string; reason: string | null }, act: () => Promise<unknown>) => {
    const r = await act();
    audits.push({ grantId, action: spec.action, reason: spec.reason, tenantId });
    return r;
  },
  auditedConfigAct: async () => undefined,
  grantHistory: async () => ({ rows: [] }),
}));


const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const SUSPENDED = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const OWNER_USER = '55555555-5555-4555-8555-555555555555';
const G1 = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const G2 = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2';
const G3 = 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3';
const FOREIGN = 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0';
const REQ = 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0';
const rid = () => randomUUID();

type Stored = { tenantId: string; requestId: string; grantId: string; fingerprint: string; actorUserId: string; ok: boolean; outcome: unknown };
type Key = { tenantId: string; requestId: string; grantId: string };
const keyOf = (k: Key) => `${k.tenantId}|${k.requestId}|${k.grantId}`;
const duplicate = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[], ip: '203.0.113.7' };

/** Whose Grant each id is: the reseller's three (two users), another reseller's one. */
const GRANTS: Record<string, { tenantId: string; userId: string }> = {
  [G1]: { tenantId: RESELLER, userId: 'u1' },
  [G2]: { tenantId: RESELLER, userId: 'u2' },
  [G3]: { tenantId: RESELLER, userId: 'u2' },
  [FOREIGN]: { tenantId: OTHER, userId: 'u9' },
};

function build() {
  calls.length = 0;
  audits.length = 0;
  throwing.clear();
  const reads: { grantId: string; tenantId: string; scope: string | undefined }[] = [];
  /** `grant_bulk_outcome`, keyed as its primary key; `racing` stores a Grant's row as if another call committed it first. */
  const stored = new Map<string, Stored>();
  const racing = new Map<string, unknown>();
  const tenants: Record<string, unknown> = {
    [PLATFORM]: { id: PLATFORM, slug: 'platform', tenantType: 'platform_owner', ownerUserId: null, status: 'active', graceEndsAt: null, deletedAt: null },
    [RESELLER]: { id: RESELLER, slug: 'acme', tenantType: 'reseller', ownerUserId: OWNER_USER, status: 'active', graceEndsAt: null, deletedAt: null },
    [SUSPENDED]: { id: SUSPENDED, slug: 'late', tenantType: 'reseller', ownerUserId: OWNER_USER, status: 'suspended', graceEndsAt: null, deletedAt: null },
  };
  const access = new ResellerAccess({
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
      findFirst: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
    },
    tenantStaffMember: { findFirst: async () => null },
  } as never);
  const tx = {
    $executeRaw: async () => 1,
    grant: {
      findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => {
        reads.push({ grantId: where.id, tenantId: where.tenantId, scope: scope() });
        const g = GRANTS[where.id];
        return g && g.tenantId === where.tenantId ? { id: where.id, userId: g.userId } : null;
      },
    },
    grantBulkOutcome: {
      findUnique: async ({ where }: { where: { tenantId_requestId_grantId: Key } }) => stored.get(keyOf(where.tenantId_requestId_grantId)) ?? null,
      findFirst: async ({ where }: { where: { tenantId: string; requestId: string; NOT: { fingerprint: string } } }) =>
        [...stored.values()].find((r) => r.tenantId === where.tenantId && r.requestId === where.requestId && r.fingerprint !== where.NOT.fingerprint) ?? null,
      create: async ({ data }: { data: Stored }) => {
        const race = racing.get(data.grantId);
        if (race) stored.set(keyOf(data), { ...data, outcome: race });
        if (stored.has(keyOf(data))) throw duplicate();
        stored.set(keyOf(data), data);
        return data;
      },
      createMany: async ({ data, skipDuplicates }: { data: Stored[]; skipDuplicates: boolean }) => {
        for (const row of data) {
          if (stored.has(keyOf(row))) {
            if (!skipDuplicates) throw duplicate();
          } else stored.set(keyOf(row), row);
        }
        return { count: data.length };
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  const service = new ResellerUserGrantsService(prisma as never, access, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { service, reads, stored, racing };
}

describe('ResellerUserGrantsService.bulk (F-311-u)', () => {
  it("adds days to each of the reseller's Grants across users, in its scope, once per id and in order, each audited", async () => {
    const { service } = build();
    const results = await service.bulk(owner, RESELLER, { requestId: rid(), action: 'days', grantIds: [G2, G1, G2, G3], days: 3, reason: 'outage 2026-09-27' });

    expect(results.map((r) => [r.grantId, r.ok])).toEqual([
      [G2, true],
      [G1, true],
      [G3, true],
    ]);
    expect(results[0]).toMatchObject({ userId: 'u2', result: { changeId: `chg-${G2}`, endsAtAfter: '2026-10-04T00:00:00.000Z', revived: false } });
    expect(calls.map((c) => [c.fn, c.grantId, c.scope])).toEqual([
      ['duration', G2, RESELLER],
      ['duration', G1, RESELLER],
      ['duration', G3, RESELLER],
    ]);
    expect(calls[0].input).toMatchObject({ actorUserId: OWNER_USER, change: { days: 3 }, reason: 'outage 2026-09-27' });
    expect(audits).toEqual([G2, G1, G3].map((grantId) => ({ grantId, action: 'grant_duration_change', reason: 'outage 2026-09-27', tenantId: RESELLER })));
  });

  it("answers another reseller's Grant as grant_not_found and never acts on it", async () => {
    const { service, reads } = build();
    const results = await service.bulk(owner, RESELLER, { requestId: rid(), action: 'freeze', grantIds: [FOREIGN, G1], reason: 'abuse' });

    expect(results).toEqual([
      { grantId: FOREIGN, ok: false, reason: 'grant_not_found' },
      { grantId: G1, userId: 'u1', ok: true, result: { frozenUntil: null, configsDisabled: 2 } },
    ]);
    expect(reads.every((r) => r.tenantId === RESELLER)).toBe(true);
    expect(calls.map((c) => c.grantId)).toEqual([G1]);
    expect(audits.map((a) => a.grantId)).toEqual([G1]);
  });

  it("answers one Grant's refusal as its outcome — a speed cap's panels included — and still runs the others", async () => {
    const { service } = build();
    throwing.set(G1, new EntitlementRefused('grant_not_active'));
    throwing.set(G2, new SpeedCapRefused('rate_limit_unsupported', [{ id: 'p1', name: 'de-1' }]));
    throwing.set(G3, new Error('connection reset'));
    const results = await service.bulk(owner, RESELLER, { requestId: rid(), action: 'speed', grantIds: [G1, G2, G3], mbps: 20, reason: 'fair use' });

    expect(results).toEqual([
      { grantId: G1, ok: false, reason: 'grant_not_active' },
      { grantId: G2, ok: false, reason: 'rate_limit_unsupported', panels: [{ id: 'p1', name: 'de-1' }] },
      { grantId: G3, ok: false, reason: 'failed' },
    ]);
    expect(audits).toEqual([]);
  });

  it('passes each action its own input and answers bytes as strings', async () => {
    const { service } = build();
    const gb = 1024 ** 3;
    const traffic = await service.bulk(owner, RESELLER, { requestId: rid(), action: 'traffic', grantIds: [G1], gb: 2, reason: 'r' });
    const gift = await service.bulk(owner, RESELLER, { requestId: rid(), action: 'traffic_gift', grantIds: [G1], gb: 1, reason: 'r' });
    const reset = await service.bulk(owner, RESELLER, { requestId: rid(), action: 'traffic_reset', grantIds: [G1], reason: 'r' });
    await service.bulk(owner, RESELLER, { requestId: rid(), action: 'unfreeze', grantIds: [G1], reason: 'r' });
    await service.bulk(owner, RESELLER, { requestId: rid(), action: 'devices', grantIds: [G1], limit: 2, reason: 'r' });
    await service.bulk(owner, RESELLER, { requestId: rid(), action: 'freeze', grantIds: [G1], until: '2026-10-05T00:00:00Z', reason: 'r' });

    expect(calls.map((c) => c.fn)).toEqual(['traffic', 'gift', 'reset', 'unfreeze', 'devices', 'freeze']);
    expect(calls[0].input).toMatchObject({ deltaBytes: BigInt(2 * gb), reason: 'r', actorUserId: OWNER_USER });
    expect(calls[1].input).toMatchObject({ bytes: BigInt(gb) });
    expect(calls[4].input).toMatchObject({ limit: 2 });
    expect(calls[5].input).toMatchObject({ until: new Date('2026-10-05T00:00:00Z') });
    expect(traffic[0]).toMatchObject({ ok: true, result: { purchasedBytesBefore: '10', purchasedBytesAfter: '20', usedBytes: '5', spent: false } });
    expect(gift[0]).toMatchObject({ ok: true, result: { purchasedBytesAfter: '20' } });
    expect(reset[0]).toMatchObject({ ok: true, result: { resetBytes: '5' } });
    expect(audits.map((a) => a.action)).toEqual([
      'grant_traffic_change',
      'grant_traffic_gift',
      'grant_traffic_reset',
      'grant_unfreeze',
      'grant_devices_set',
      'grant_freeze',
    ]);
  });

  it('refuses a suspended reseller as reseller_suspended, and reads no Grant', async () => {
    const { service, reads } = build();
    await expect(service.bulk(owner, SUSPENDED, { requestId: rid(), action: 'days', grantIds: [G1], days: 3, reason: 'r' })).rejects.toBeInstanceOf(ResellerUserGrantsRefused);
    expect(reads).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('answers a repeated request with the first call\'s outcomes and acts on no Grant twice (F-311-u1)', async () => {
    const { service, stored } = build();
    throwing.set(G2, new EntitlementRefused('grant_closed'));
    const body: GrantBulkBody = { requestId: REQ, action: 'days', grantIds: [G1, G2, FOREIGN], days: 3, reason: 'outage' };
    const first = await service.bulk(owner, RESELLER, body);
    throwing.clear();
    const again = await service.bulk(owner, RESELLER, body);

    expect(first).toEqual([
      { grantId: G1, userId: 'u1', ok: true, result: expect.objectContaining({ changeId: `chg-${G1}` }) },
      { grantId: G2, ok: false, reason: 'grant_closed' },
      { grantId: FOREIGN, ok: false, reason: 'grant_not_found' },
    ]);
    expect(again).toEqual(first);
    expect(calls.map((c) => [c.fn, c.grantId])).toEqual([
      ['duration', G1],
      ['duration', G2],
    ]);
    expect(audits.map((a) => a.grantId)).toEqual([G1]);
    expect([...stored.values()].every((r) => r.tenantId === RESELLER && r.requestId === REQ && r.actorUserId === OWNER_USER)).toBe(true);
    expect([...stored.values()].map((r) => [r.grantId, r.ok])).toEqual([
      [G1, true],
      [G2, false],
      [FOREIGN, false],
    ]);
  });

  it('tries a failed Grant again on a repeat — nothing was done to it — and only that one', async () => {
    const { service } = build();
    throwing.set(G2, new Error('connection reset'));
    const body: GrantBulkBody = { requestId: REQ, action: 'traffic', grantIds: [G1, G2], gb: 2, reason: 'r' };
    expect((await service.bulk(owner, RESELLER, body)).map((r) => r.ok)).toEqual([true, false]);
    throwing.clear();
    calls.length = 0;
    const again = await service.bulk(owner, RESELLER, body);

    expect(again.map((r) => [r.grantId, r.ok])).toEqual([
      [G1, true],
      [G2, true],
    ]);
    expect(calls.map((c) => c.grantId)).toEqual([G2]);
  });

  it('answers a concurrent repeat with the outcome the other call committed — its own act rolls back', async () => {
    const { service, racing } = build();
    const theirs = { grantId: G1, userId: 'u1', ok: true, result: { changeId: 'chg-theirs' } };
    racing.set(G1, theirs);
    const results = await service.bulk(owner, RESELLER, { requestId: REQ, action: 'days', grantIds: [G1], days: 3, reason: 'r' });

    expect(results).toEqual([theirs]);
  });

  it('refuses the same requestId with another body as request_reused, and acts on nothing', async () => {
    const { service } = build();
    await service.bulk(owner, RESELLER, { requestId: REQ, action: 'days', grantIds: [G1], days: 3, reason: 'r' });
    calls.length = 0;
    for (const body of [
      { requestId: REQ, action: 'days', grantIds: [G1], days: 30, reason: 'r' },
      { requestId: REQ, action: 'days', grantIds: [G1, G2], days: 3, reason: 'r' },
      { requestId: REQ, action: 'freeze', grantIds: [G1], reason: 'r' },
    ] as GrantBulkBody[]) {
      await expect(service.bulk(owner, RESELLER, body)).rejects.toMatchObject({ reason: 'request_reused' });
    }
    expect(calls).toEqual([]);
    // The same selection named again, a duplicate included, is the same request.
    expect(await service.bulk(owner, RESELLER, { requestId: REQ, action: 'days', grantIds: [G1, G1], days: 3, reason: 'r' })).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('the body: a requestId, 1..50 Grants, a reason always, relative days only, and no delete, renew or link reset in bulk', () => {
    const ok = (b: unknown) => grantBulkSchema.safeParse({ requestId: REQ, ...(b as object) }).success;
    expect(ok({ action: 'days', grantIds: [G1], days: 3, reason: 'outage' })).toBe(true);
    expect(ok({ action: 'days', grantIds: Array.from({ length: 51 }, () => G1), days: 3, reason: 'r' })).toBe(false);
    expect(ok({ action: 'days', grantIds: [], days: 3, reason: 'r' })).toBe(false);
    expect(ok({ action: 'days', grantIds: [G1], days: 3 })).toBe(false);
    expect(ok({ action: 'days', grantIds: [G1], endsAt: '2026-11-01T00:00:00Z', reason: 'r' })).toBe(false);
    expect(ok({ action: 'days', grantIds: [G1], days: 0, reason: 'r' })).toBe(false);
    expect(ok({ action: 'speed', grantIds: [G1], mbps: null, reason: 'r' })).toBe(true);
    expect(ok({ action: 'traffic', grantIds: [G1], gb: 0, reason: 'r' })).toBe(false);
    for (const action of ['delete', 'renew', 'rotate_token']) expect(ok({ action, grantIds: [G1], reason: 'r' })).toBe(false);
    expect(grantBulkSchema.safeParse({ action: 'days', grantIds: [G1], days: 3, reason: 'r' }).success).toBe(false);
    expect(ok({ requestId: 'not-a-uuid', action: 'days', grantIds: [G1], days: 3, reason: 'r' })).toBe(false);
  });
});
