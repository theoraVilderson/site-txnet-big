/**
 * Releasing an inbound from groups with live configs there (F-027-es, ADR-0127
 * decision 6) — the way out of `inbound_has_configs`, a kind of F-311-ad's
 * config move job. What would break silently:
 *
 *  - **the 409 names one group only** — the page could not offer the release
 *    for the others; it names every group losing the inbound and its count;
 *  - **a release that changes the listing up front** — the ADR's rule is the
 *    listing goes only when the job ends, so a cancel leaves it as it was;
 *    meanwhile a hold stops new placements of those groups there;
 *  - **`move` cutting a user off** — a Grant left with no live line is
 *    `no_target` and its config stays serving;
 *  - **`empty` leaving a paid Grant with nothing** — an active Grant with no
 *    line left is paused or refunded as the job chose, as an evict does;
 *  - a group that does not sell it, or is already being released, is refused.
 */
import { ConfigMoveJobKind, ConfigMoveJobStatus, ConfigProtocol, EvictOrphans, GrantStatus, InboundAudience, TenantType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';

import { GroupFulfilmentRefused } from '../traffic/group-fulfilment';
import { applyRelease, InboundReleaseActs, MoveItemRefused } from '../traffic/inbound-release';
import { sellingInbounds } from '../traffic/selling-settings';
import { InboundReleaseService } from './inbound-release';
import { InboundHeldElsewhere } from './member-inbounds';
import { releaseInboundSchema } from './panel-registration.schema';
import { refusing } from './systems-refusals';

const jobAudits: { action: string; reason: string | null }[] = [];
const configAudits: { configId: string; action: string; tenantId: string }[] = [];
vi.mock('../grant-audit/grant-audit', () => ({
  auditMoveJob: async (_tx: unknown, _actor: unknown, _tenantId: string, action: string, _id: string, _b: unknown, _a: unknown, reason: string | null) => void jobAudits.push({ action, reason }),
  auditedConfigAct: async (_tx: unknown, _actor: unknown, tenantId: string, configId: string, action: string, _reason: unknown, act: () => Promise<unknown>) => {
    const r = await act();
    configAudits.push({ configId, action, tenantId });
    return r;
  },
}));
/** The configs the selection SQL would freeze: `selected` per test. */
let selected = 0;
vi.mock('../traffic/inbound-release', async (original) => ({
  ...(await original<object>()),
  insertReleaseSelection: async () => selected,
}));

const OWNER = '11111111-1111-4111-8111-111111111111';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PANEL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const [EU, GAMING, ASIA] = ['c', 'd', 'e'].map((x) => `${x.repeat(8)}-${x.repeat(4)}-4${x.repeat(3)}-8${x.repeat(3)}-${x.repeat(12)}`);
const actor = { adminId: ADMIN, tenantId: OWNER, ip: '203.0.113.7' };

type Row = Record<string, unknown>;
const match = (r: Row, where: Row) =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in (v as Row)) return ((v as { in: unknown[] }).in).includes(r[k]);
    if (v && typeof v === 'object' && 'notIn' in (v as Row)) return !((v as { notIn: unknown[] }).notIn).includes(r[k]);
    if (k === 'group') return true;
    return (r[k] ?? null) === v;
  });

/** One platform panel, three member groups; inbound 1 is every group's, 3 is listed to EU and GAMING. */
function harness() {
  jobAudits.length = 0;
  selected = 0;
  const members: Row[] = [EU, GAMING, ASIA].map((groupId) => ({ groupId, panelId: PANEL, group: { tenantId: null } }));
  const inbounds: Row[] = [
    { panelId: PANEL, remoteId: '1', audience: InboundAudience.every_group },
    { panelId: PANEL, remoteId: '3', audience: InboundAudience.listed },
  ];
  const listings: Row[] = [EU, GAMING].map((groupId) => ({ groupId, panelId: PANEL, inboundRemoteId: '3' }));
  const holds: Row[] = [];
  const jobs: Row[] = [];
  const outbox: Row[] = [];
  const tx = {
    $executeRaw: async () => 1,
    panel: { findFirst: async ({ where }: { where: Row }) => (where.id === PANEL ? { id: PANEL } : null) },
    panelInbound: {
      findUnique: async ({ where }: { where: { panelId_remoteId: Row } }) => inbounds.find((i) => match(i, where.panelId_remoteId)) ?? null,
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        inbounds.filter((i) => match(i, where)).forEach((i) => Object.assign(i, data));
        return { count: 1 };
      },
    },
    panelGroupMember: { findMany: async ({ where }: { where: Row }) => members.filter((m) => match(m, where)) },
    panelGroupMemberInbound: {
      count: async ({ where }: { where: Row }) => listings.filter((l) => match(l, where)).length,
      createMany: async ({ data }: { data: Row[] }) => void listings.push(...data),
      deleteMany: async ({ where }: { where: Row }) => {
        const gone = listings.filter((l) => match(l, where));
        gone.forEach((l) => listings.splice(listings.indexOf(l), 1));
        return { count: gone.length };
      },
    },
    inboundRelease: {
      count: async ({ where }: { where: Row }) => holds.filter((h) => match(h, where)).length,
      createMany: async ({ data }: { data: Row[] }) => void holds.push(...data),
      deleteMany: async ({ where }: { where: Row }) => {
        const gone = holds.filter((h) => match(h, where));
        gone.forEach((h) => holds.splice(holds.indexOf(h), 1));
        return { count: gone.length };
      },
    },
    configMoveJob: {
      findUnique: async ({ where }: { where: { tenantId_requestId: Row } }) => jobs.find((j) => match(j, where.tenantId_requestId)) ?? null,
      findFirst: async ({ where }: { where: Row }) => jobs.find((j) => match(j, where)) ?? null,
      findUniqueOrThrow: async ({ where }: { where: Row }) => jobs.find((j) => match(j, where)),
      create: async ({ data }: { data: Row }) => {
        const row = { id: randomUUID(), toPanelId: null, status: ConfigMoveJobStatus.running, okCount: 0, refusedCount: 0, failedCount: 0, createdAt: new Date(), finishedAt: null, purgedAt: null, ...data };
        jobs.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => Object.assign(jobs.find((j) => match(j, where)) as Row, data),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = jobs.filter((j) => match(j, where));
        hit.forEach((j) => Object.assign(j, data));
        return { count: hit.length };
      },
    },
    outboxEvent: { create: async ({ data }: { data: Row }) => void outbox.push(data) },
  };
  const prisma = { tenant: { findUnique: async () => ({ tenantType: TenantType.platform_owner }) } };
  const crossTenant = { ...tx, $transaction: async (work: (t: typeof tx) => Promise<unknown>) => work(tx) };
  const service = new InboundReleaseService(prisma as never, crossTenant as never);
  return { service, tx, inbounds, listings, holds, jobs, outbox };
}

const body = (over: Row = {}) => ({ requestId: randomUUID(), groups: [GAMING], mode: 'move' as const, reason: 'router moves to the new site', ...over });

describe('the 409 a release answers', () => {
  it('names every group losing the inbound, with its count, beside the first', async () => {
    const e = new InboundHeldElsewhere('3', { id: EU, name: 'EU' }, 4, [{ groupId: EU, configs: 4 }, { groupId: GAMING, configs: 9 }]);
    await expect(refusing(async () => { throw e; })).rejects.toMatchObject({
      response: { reason: 'inbound_has_configs', facts: { remoteId: '3', groupId: EU, configs: 4, groups: [{ groupId: EU, configs: 4 }, { groupId: GAMING, configs: 9 }] } },
    });
  });
});

describe('InboundReleaseService.start', () => {
  it('freezes the configs, holds the inbound from new placements, and leaves the listing until the job ends', async () => {
    const { service, listings, holds } = harness();
    selected = 7;
    const job = await service.start(actor, PANEL, '3', body());

    expect(job).toMatchObject({ kind: ConfigMoveJobKind.release_move, status: 'running', total: 7, source: { panelId: PANEL, remoteId: '3', groupIds: [GAMING] } });
    expect(holds).toEqual([{ groupId: GAMING, panelId: PANEL, inboundRemoteId: '3', tenantId: null, jobId: job.id }]);
    expect(listings.map((l) => l.groupId).sort()).toEqual([EU, GAMING].sort());
    expect(jobAudits).toEqual([{ action: 'config_move_start', reason: 'router moves to the new site' }]);
  });

  it('with nothing to move, ends at once and applies the release', async () => {
    const { service, listings, holds } = harness();
    const job = await service.start(actor, PANEL, '3', body());
    expect(job).toMatchObject({ status: 'done', total: 0 });
    expect(listings.map((l) => l.groupId)).toEqual([EU]);
    expect(holds).toEqual([]);
  });

  it('one requestId, one job; another body is request_reused', async () => {
    const { service } = harness();
    selected = 2;
    const first = body();
    const job = await service.start(actor, PANEL, '3', first);
    expect((await service.start(actor, PANEL, '3', first)).id).toBe(job.id);
    await expect(service.start(actor, PANEL, '3', { ...first, mode: 'empty', orphans: EvictOrphans.pause })).rejects.toMatchObject({ reason: 'request_reused' });
  });

  it('refuses a group that does not sell it, one not on the panel, and one already being released', async () => {
    const { service } = harness();
    selected = 2;
    await expect(service.start(actor, PANEL, '3', body({ groups: [ASIA] }))).rejects.toMatchObject({ reason: 'not_a_seller' });
    await expect(service.start(actor, PANEL, '3', body({ groups: [randomUUID()] }))).rejects.toMatchObject({ reason: 'member_not_found' });
    await service.start(actor, PANEL, '3', body());
    await expect(service.start(actor, PANEL, '3', body())).rejects.toMatchObject({ reason: 'already_releasing' });
  });

  it('a cancel removes the hold and leaves the listing as it was', async () => {
    const { service, listings, holds, outbox } = harness();
    selected = 3;
    const job = await service.start(actor, PANEL, '3', body());
    expect(await service.cancel(actor, job.id)).toMatchObject({ status: 'cancelled' });
    expect(holds).toEqual([]);
    expect(listings.map((l) => l.groupId).sort()).toEqual([EU, GAMING].sort());
    expect(outbox).toHaveLength(1);
  });
});

describe('applyRelease — when the job ends', () => {
  it('an every-group inbound becomes listed to every other member; a listed one loses the released groups', async () => {
    const { tx, inbounds, listings, holds } = harness();
    holds.push({ groupId: GAMING, panelId: PANEL, inboundRemoteId: '1', jobId: 'job-1' });
    await applyRelease(tx as never, { id: 'job-1', source: { panelId: PANEL, remoteId: '1', groupIds: [GAMING] } });
    expect(inbounds[0].audience).toBe(InboundAudience.listed);
    expect(listings.filter((l) => l.inboundRemoteId === '1').map((l) => l.groupId).sort()).toEqual([EU, ASIA].sort());
    expect(holds).toEqual([]);

    await applyRelease(tx as never, { id: 'job-2', source: { panelId: PANEL, remoteId: '3', groupIds: [EU, GAMING] } });
    expect(listings.filter((l) => l.inboundRemoteId === '3')).toEqual([]);
  });
});

describe('sellingInbounds under a release', () => {
  it('sells nobody new an inbound the group is being released from', () => {
    const member = { inbounds: [], releases: [{ inboundRemoteId: '1' }], panel: { inbounds: [{ remoteId: '1', protocol: ConfigProtocol.vless, maxClients: null }, { remoteId: '2', protocol: ConfigProtocol.vless, maxClients: null }] } };
    expect(sellingInbounds(member).map((i) => i.remoteId)).toEqual(['2']);
  });
});

describe('InboundReleaseActs — the two ways out, one config', () => {
  const job = (kind: ConfigMoveJobKind, orphans: EvictOrphans | null = null) => ({ id: 'job', tenantId: OWNER, actorUserId: ADMIN, actorIp: '203.0.113.7', reason: 'r', kind, orphans }) as never;

  function acts(opts: { liveAfter: number; grantStatus?: GrantStatus; fulfil?: () => Promise<unknown> }) {
    const calls: string[] = [];
    const tx = {
      config: { findUnique: async () => ({ grantId: 'g1', tenantId: 'reseller-1' }), count: async () => opts.liveAfter },
      grant: { findUnique: async () => ({ status: opts.grantStatus ?? GrantStatus.active }) },
    };
    const actions = { drain: async () => void calls.push('drain'), retire: async () => void calls.push('retire') };
    const fulfilment = { fulfil: opts.fulfil ?? (async () => void calls.push('fulfil')) };
    const drains = { orphans: { pause: async () => void calls.push('pause'), refund: async () => void calls.push('refund') } };
    return { acts: new InboundReleaseActs(actions as never, fulfilment as never, drains as never), tx: tx as never, calls };
  }

  it('move: drains the config and fulfils its Grant, audited in the config\'s tenant', async () => {
    configAudits.length = 0;
    const { acts: a, tx, calls } = acts({ liveAfter: 1 });
    await a.move(tx, job(ConfigMoveJobKind.release_move), 'c1');
    expect(calls).toEqual(['drain', 'fulfil']);
    expect(configAudits).toEqual([{ configId: 'c1', action: 'config_move', tenantId: 'reseller-1' }]);
  });

  it('move: a Grant left with no live line is no_target, so the drain rolls back and it keeps serving', async () => {
    const { acts: a, tx } = acts({ liveAfter: 0 });
    await expect(a.move(tx, job(ConfigMoveJobKind.release_move), 'c1')).rejects.toBeInstanceOf(MoveItemRefused);
  });

  it('move: a Grant no longer carrying service needs no next placement', async () => {
    const { acts: a, tx } = acts({ liveAfter: 0, fulfil: async () => { throw new GroupFulfilmentRefused('grant_not_fulfillable'); } });
    await expect(a.move(tx, job(ConfigMoveJobKind.release_move), 'c1')).resolves.toBeNull();
  });

  it('empty: retires the config; an active Grant left with no line is paused or refunded as the job chose', async () => {
    const paused = acts({ liveAfter: 0 });
    await paused.acts.empty(paused.tx, job(ConfigMoveJobKind.release_empty, EvictOrphans.pause), 'c1');
    expect(paused.calls).toEqual(['retire', 'pause']);

    const refunded = acts({ liveAfter: 0 });
    await refunded.acts.empty(refunded.tx, job(ConfigMoveJobKind.release_empty, EvictOrphans.refund), 'c1');
    expect(refunded.calls).toEqual(['retire', 'refund']);

    const served = acts({ liveAfter: 2 });
    await served.acts.empty(served.tx, job(ConfigMoveJobKind.release_empty, EvictOrphans.refund), 'c1');
    expect(served.calls).toEqual(['retire']);
  });
});

describe('releaseInboundSchema', () => {
  it('takes groups once, a way out, orphans only for empty and required there', () => {
    const ok = { requestId: randomUUID(), groups: [EU], mode: 'move', reason: 'r' };
    expect(releaseInboundSchema.safeParse(ok).success).toBe(true);
    expect(releaseInboundSchema.safeParse({ ...ok, mode: 'empty', orphans: 'refund' }).success).toBe(true);
    expect(releaseInboundSchema.safeParse({ ...ok, mode: 'empty' }).success).toBe(false);
    expect(releaseInboundSchema.safeParse({ ...ok, orphans: 'pause' }).success).toBe(false);
    expect(releaseInboundSchema.safeParse({ ...ok, groups: [EU, EU] }).success).toBe(false);
    expect(releaseInboundSchema.safeParse({ ...ok, groups: [] }).success).toBe(false);
  });
});
