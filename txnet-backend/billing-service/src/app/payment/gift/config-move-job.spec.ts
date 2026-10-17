/**
 * A reseller's admin moves many configs to one panel as a job (F-311-ad,
 * D-63): every live config on a source panel, or every live config of the
 * users named. Each move is the single move's own (`ConfigActions.move`, its
 * `config_move` audit row); what the job adds, and each case below is a way
 * it breaks quietly:
 *
 *  - **the selection is frozen at the confirm** — the count the admin saw is
 *    what is moved; a target that is not one of the move targets, the source
 *    itself, or nothing to move is refused before any job is kept;
 *  - **one `requestId`, one job** — a double click answers the same job;
 *    another body with the id is `request_reused`;
 *  - **each config once, in the job's tenant, as the job's admin**, at most a
 *    batch of 50 a drain; the item's outcome commits with its move, so a
 *    retry never reports a moved config as refused;
 *  - a refusal is kept at once, a throw nobody named is tried again and then
 *    `failed`; a Grant already served on the target with that protocol is
 *    `already_on_target`, never given a second line there;
 *  - **progress by outbox event** — every batch and a cancel tell the job's
 *    tenant, so its page re-reads instead of polling (C-14);
 *  - a cancel stops the configs not yet reached, written down once.
 */
import { ActorType, ConfigProtocol, Prisma } from '@prisma/client';
import { OutboxEventType, ResellerAccess, TenantContext } from '@txnet-backend/shared-core';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';

import { ConfigActionRefused } from '../../traffic/config-actions';
import { CONFIG_MOVE_BATCH_SIZE, ConfigMoveJobDrainService, ResellerConfigMoveJobService } from './config-move-job';
import { configMoveJobSchema, ConfigMoveSelection } from './config-move-job.schema';

type Config = { id: string; tenantId: string; userId: string; grantId: string; panelId: string; protocol: ConfigProtocol; live: boolean };
const CONFIGS = new Map<string, Config>();
const scope = () => TenantContext.currentOrNull()?.id;

const audits: { configId: string; action: string; actor: string; tenantId: string; reason: string | null; scope: string | undefined }[] = [];
const jobAudits: { action: string; jobId: string; actor: string; tenantId: string; reason: string | null }[] = [];
vi.mock('../../grant-audit/grant-audit', () => ({
  auditMoveJob: async (_tx: unknown, actor: { userId: string }, tenantId: string, action: string, jobId: string, _b: unknown, _a: unknown, reason: string | null) => {
    jobAudits.push({ action, jobId, actor: actor.userId, tenantId, reason });
  },
  auditedConfigAct: async (_tx: unknown, actor: { userId: string }, tenantId: string, configId: string, action: string, reason: string | null, act: () => Promise<unknown>) => {
    const r = await act();
    audits.push({ configId, action, actor: actor.userId, tenantId, reason, scope: scope() });
    return r;
  },
}));

/** The selection over the fake configs, as the SQL reads it: the path's tenant, live, not already on the target. */
const matches = (tenantId: string, s: ConfigMoveSelection) => (c: Config) =>
  c.tenantId === tenantId && c.live && c.panelId !== s.toPanelId && (sourceOf(s).panelId ? c.panelId === sourceOf(s).panelId : (sourceOf(s).userIds ?? []).includes(c.userId));
const sourceOf = (s: ConfigMoveSelection) => s.source as { panelId?: string; userIds?: string[] };
vi.mock('./config-move-selection', async (original) => ({
  ...(await original<object>()),
  countMoveSelection: async (_tx: unknown, tenantId: string, s: ConfigMoveSelection) => [...CONFIGS.values()].filter(matches(tenantId, s)).length,
  insertMoveSelection: async (tx: { configMoveJobItem: { createMany: (a: unknown) => Promise<unknown> } }, jobId: string, tenantId: string, s: ConfigMoveSelection, limit: number) => {
    const ids = [...CONFIGS.values()].filter(matches(tenantId, s)).map((c) => c.id).sort().slice(0, limit);
    await tx.configMoveJobItem.createMany({ data: ids.map((configId) => ({ jobId, tenantId, configId })) });
    return ids.length;
  },
}));

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '44444444-4444-4444-8444-444444444444';
const OWNER = '55555555-5555-4555-8555-555555555555';
const FROM = '66666666-6666-4666-8666-666666666666';
const TO = '77777777-7777-4777-8777-777777777777';
const FOREIGN = '88888888-8888-4888-8888-888888888888';
const owner = { userId: OWNER, tenantId: PLATFORM, permissions: [] as string[], ip: '203.0.113.7' };
const c = (n: number) => `c${n}c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1`;

type Row = Record<string, unknown>;
const duplicate = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
const pick = (rows: Row[], where: Row = {}) =>
  rows.filter((r) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'job') return Object.entries(v as Row).every(([jk, jv]) => (r.__job as () => Row)()[jk] === jv);
      if (v && typeof v === 'object' && 'in' in (v as Row)) return ((v as { in: unknown[] }).in).includes(r[k]);
      if (v && typeof v === 'object' && 'not' in (v as Row)) return r[k] !== (v as Row).not;
      return r[k] === v;
    }),
  );
const apply = (r: Row, data: Row) => {
  for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && 'increment' in (v as Row) ? (r[k] as number) + ((v as Row).increment as number) : v;
  return r;
};

function build() {
  CONFIGS.clear();
  audits.length = 0;
  jobAudits.length = 0;
  for (const n of [1, 2, 3]) CONFIGS.set(c(n), { id: c(n), tenantId: RESELLER, userId: `u${n}`, grantId: `g${n}`, panelId: FROM, protocol: ConfigProtocol.vless, live: true });
  CONFIGS.set(c(4), { id: c(4), tenantId: RESELLER, userId: 'u4', grantId: 'g4', panelId: FROM, protocol: ConfigProtocol.vless, live: false });
  CONFIGS.set(c(5), { id: c(5), tenantId: OTHER, userId: 'u5', grantId: 'g5', panelId: FROM, protocol: ConfigProtocol.vless, live: true });

  const jobs: Row[] = [];
  const items: Row[] = [];
  const outbox: { type: string; payload: Row }[] = [];
  const moves: { configId: string; toPanelId: string; actor: unknown; scope: string | undefined }[] = [];
  const throwing = new Map<string, number>();
  const refusing = new Map<string, string>();
  const jobOf = (id: unknown) => jobs.find((j) => j.id === id) as Row;
  const tenants: Record<string, unknown> = {
    [PLATFORM]: { id: PLATFORM, slug: 'platform', tenantType: 'platform_owner', ownerUserId: null, status: 'active', graceEndsAt: null, deletedAt: null },
    [RESELLER]: { id: RESELLER, slug: 'acme', tenantType: 'reseller', ownerUserId: OWNER, status: 'active', graceEndsAt: null, deletedAt: null },
    [OTHER]: { id: OTHER, slug: 'beta', tenantType: 'reseller', ownerUserId: OWNER, status: 'active', graceEndsAt: null, deletedAt: null },
  };
  const access = new ResellerAccess({
    tenant: { findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null, findFirst: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null },
    tenantStaffMember: { findFirst: async () => null },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ $executeRaw: async () => 1, adminAuditLog: { create: async () => ({}) }, supportAccessConsent: { findFirst: async () => ({ id: 'consent', scope: 'act', expiresAt: new Date('2100-01-01') }) } }),
  } as never);
  const inScope = (rows: Row[]) => rows.filter((r) => scope() === undefined || r.tenantId === scope());
  const tx = {
    $executeRaw: async () => 1,
    // A move target: TO is shared and accepted; FOREIGN is another reseller's own.
    panel: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === TO || where.id === FROM ? { id: where.id } : null) },
    config: {
      findFirst: async ({ where }: { where: { grantId?: string; panelId?: string; protocol?: ConfigProtocol; id?: string } }) => {
        if (where.id) {
          const own = CONFIGS.get(where.id);
          return own ? { grantId: own.grantId, protocol: own.protocol } : null;
        }
        return [...CONFIGS.values()].find((x) => x.live && x.grantId === where.grantId && x.panelId === where.panelId && x.protocol === where.protocol) ? { id: 'held' } : null;
      },
    },
    outboxEvent: { create: async ({ data }: { data: { type: string; payload: Row } }) => void outbox.push(data) },
    configMoveJob: {
      findUnique: async ({ where }: { where: Row }) => pick(inScope(jobs), (where.tenantId_requestId as Row) ?? where)[0] ?? null,
      findFirst: async ({ where }: { where: Row }) => pick(inScope(jobs), where)[0] ?? null,
      findMany: async ({ where, skip = 0, take = 20 }: { where?: Row; skip?: number; take?: number }) => pick(inScope(jobs), where ?? {}).reverse().slice(skip, skip + take),
      count: async () => inScope(jobs).length,
      create: async ({ data }: { data: Row }) => {
        if (jobs.some((j) => j.tenantId === data.tenantId && j.requestId === data.requestId)) throw duplicate();
        const row = { id: randomUUID(), status: 'running', okCount: 0, refusedCount: 0, failedCount: 0, createdAt: new Date(Date.now() + jobs.length), finishedAt: null, purgedAt: null, ...data };
        jobs.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => apply(pick(inScope(jobs), where)[0], data),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = pick(inScope(jobs), where);
        hit.forEach((r) => apply(r, data));
        return { count: hit.length };
      },
    },
    configMoveJobItem: {
      createMany: async ({ data }: { data: Row[] }) => {
        for (const d of data) items.push({ attempts: 0, doneAt: null, ok: null, reason: null, movedTo: null, ...d, __job: () => jobOf(d.jobId) });
        return { count: data.length };
      },
      findMany: async ({ where, skip = 0, take = 20 }: { where: Row; skip?: number; take?: number }) =>
        pick(inScope(items), where).sort((a, b) => String(a.configId).localeCompare(String(b.configId))).slice(skip, skip + take),
      count: async ({ where }: { where: Row }) => pick(inScope(items), where).length,
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = pick(inScope(items), where);
        hit.forEach((r) => apply(r, data));
        return { count: hit.length };
      },
    },
  };
  /** A throw rolls back what the transaction wrote, as Postgres would. */
  const prisma = {
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      const before = { jobs: jobs.map((j) => ({ ...j })), items: items.map((i) => ({ ...i })), outbox: outbox.length, moves: moves.length, audits: audits.length, jobAudits: jobAudits.length };
      try {
        return await fn(tx);
      } catch (e) {
        jobs.splice(0, jobs.length, ...before.jobs);
        items.splice(0, items.length, ...before.items);
        outbox.length = before.outbox;
        moves.length = before.moves;
        audits.length = before.audits;
        jobAudits.length = before.jobAudits;
        throw e;
      }
    },
  };
  const crossTenant = { configMoveJob: tx.configMoveJob, configMoveJobItem: tx.configMoveJobItem };
  const actions = {
    move: async (_t: unknown, input: { configId: string; toPanelId: string; actor: unknown }) => {
      const left = throwing.get(input.configId) ?? 0;
      if (left > 0) {
        throwing.set(input.configId, left - 1);
        throw new Error('connection reset');
      }
      const reason = refusing.get(input.configId);
      if (reason) throw new ConfigActionRefused(reason as never, input.configId);
      moves.push({ ...input, scope: scope() });
      return { configId: `new-${input.configId}`, uuid: 'u', retiredConfigId: input.configId };
    },
  };
  const service = new ResellerConfigMoveJobService(prisma as never, access);
  const drainer = new ConfigMoveJobDrainService(prisma as never, crossTenant as never, actions as never);
  return { service, drainer, jobs, items, outbox, moves, throwing, refusing };
}

const body = (over: Row = {}) => ({ requestId: randomUUID(), source: { panelId: FROM }, toPanelId: TO, reason: 'de-2 is down', ...over }) as never;

describe('ResellerConfigMoveJobService.start — the selection frozen at the confirm', () => {
  it('freezes the live configs of the reseller on the source panel as the job\'s items, and writes the start down once', async () => {
    const { service, items } = build();
    const job = await service.start(owner, RESELLER, body());

    expect(job).toMatchObject({ status: 'running', total: 3, processed: 0, toPanelId: TO, source: { panelId: FROM } });
    expect(items.map((i) => i.configId).sort()).toEqual([c(1), c(2), c(3)]);
    expect(jobAudits).toEqual([{ action: 'config_move_start', jobId: job.id, actor: OWNER, tenantId: RESELLER, reason: 'de-2 is down' }]);
  });

  it('by users: every live config of the users named, never another tenant\'s', async () => {
    const { service, items } = build();
    await service.start(owner, RESELLER, body({ source: { userIds: ['u1', 'u5'] } }));
    expect(items.map((i) => i.configId)).toEqual([c(1)]);
  });

  it('one requestId, one job: a repeat answers it and selects nothing again; another body is request_reused', async () => {
    const { service, items } = build();
    const first = body();
    const job = await service.start(owner, RESELLER, first);
    expect((await service.start(owner, RESELLER, first)).id).toBe(job.id);
    expect(items).toHaveLength(3);
    await expect(service.start(owner, RESELLER, body({ requestId: (first as Row).requestId, toPanelId: FROM, source: { userIds: ['u1'] } }))).rejects.toMatchObject({ reason: 'request_reused' });
  });

  it('refuses a target that is not a move target, the source itself, and nothing to move — no job kept', async () => {
    const { service, jobs } = build();
    await expect(service.start(owner, RESELLER, body({ toPanelId: FOREIGN }))).rejects.toMatchObject({ reason: 'panel_not_found' });
    await expect(service.start(owner, RESELLER, body({ toPanelId: FROM }))).rejects.toMatchObject({ reason: 'same_panel' });
    await expect(service.start(owner, RESELLER, body({ source: { userIds: ['nobody'] } }))).rejects.toMatchObject({ reason: 'selection_empty' });
    expect(jobs).toHaveLength(0);
  });
});

describe('ConfigMoveJobDrainService.drain — each config once, as the job\'s admin', () => {
  it('moves each item in the job\'s tenant through ConfigActions.move, audited as config_move, and tells the tenant\'s page', async () => {
    const { service, drainer, moves, items, outbox } = build();
    const job = await service.start(owner, RESELLER, body());

    expect(await drainer.drain()).toEqual({ jobs: 1, moved: 3, finished: 1 });
    expect(moves.map((m) => [m.configId, m.toPanelId, m.scope])).toEqual([c(1), c(2), c(3)].map((id) => [id, TO, RESELLER]));
    expect(moves[0].actor).toEqual({ actorType: ActorType.admin, actorId: OWNER });
    expect(audits.map((a) => [a.action, a.reason, a.tenantId])).toEqual(Array(3).fill(['config_move', 'de-2 is down', RESELLER]));
    expect(items.map((i) => [i.ok, i.movedTo])).toEqual([c(1), c(2), c(3)].map((id) => [true, `new-${id}`]));
    expect(outbox).toEqual([{ aggregate: 'network.config_move_job', aggregateId: job.id, type: OutboxEventType.CONFIG_MOVE_JOB_PROGRESS, payload: { tenantId: RESELLER, jobId: job.id } }]);
    expect(await service.job(owner, RESELLER, job.id)).toMatchObject({ status: 'done', processed: 3, ok: 3 });
    expect(await drainer.drain()).toEqual({ jobs: 0, moved: 0, finished: 0 });
  });

  it('moves at most a batch a drain, and the next drain resumes where it stopped', async () => {
    const { service, drainer, moves } = build();
    for (let n = 10; n < 10 + CONFIG_MOVE_BATCH_SIZE + 5; n++) CONFIGS.set(c(n), { id: c(n), tenantId: RESELLER, userId: `u${n}`, grantId: `g${n}`, panelId: FROM, protocol: ConfigProtocol.vless, live: true });
    await service.start(owner, RESELLER, body());

    await drainer.drain();
    expect(moves).toHaveLength(CONFIG_MOVE_BATCH_SIZE);
    await drainer.drain();
    expect(moves).toHaveLength(CONFIG_MOVE_BATCH_SIZE + 8);
  });

  it('keeps a refusal at once, tries a throw again and then fails it, and refuses a Grant already on the target', async () => {
    const { service, drainer, items, refusing, throwing } = build();
    CONFIGS.set(c(6), { id: c(6), tenantId: RESELLER, userId: 'u1', grantId: 'g1', panelId: TO, protocol: ConfigProtocol.vless, live: true });
    const job = await service.start(owner, RESELLER, body());
    refusing.set(c(2), 'config_retired');
    throwing.set(c(3), 5);

    await drainer.drain();
    const of = (id: string) => items.find((i) => i.configId === id) as Row;
    expect([of(c(1)).ok, of(c(1)).reason]).toEqual([false, 'already_on_target']);
    expect([of(c(2)).ok, of(c(2)).reason]).toEqual([false, 'config_retired']);
    expect(of(c(3)).doneAt).toBeNull();
    await drainer.drain();
    await drainer.drain();
    expect([of(c(3)).ok, of(c(3)).reason]).toEqual([false, 'failed']);
    expect(await service.job(owner, RESELLER, job.id)).toMatchObject({ status: 'done', ok: 0, refused: 2, failed: 1 });
    expect((await service.outcomes(owner, RESELLER, job.id, { page: 1, pageSize: 20, problems: true })).rows).toEqual([
      { configId: c(1), ok: false, reason: 'already_on_target' },
      { configId: c(2), ok: false, reason: 'config_retired' },
      { configId: c(3), ok: false, reason: 'failed' },
    ]);
  });
});

describe('ResellerConfigMoveJobService.cancel', () => {
  it('stops the configs not yet reached, writes the cancel down once, and tells the page', async () => {
    const { service, drainer, moves, outbox } = build();
    const job = await service.start(owner, RESELLER, body());
    expect(await service.cancel(owner, RESELLER, job.id)).toMatchObject({ status: 'cancelled', processed: 0 });
    await service.cancel(owner, RESELLER, job.id);

    expect(await drainer.drain()).toEqual({ jobs: 0, moved: 0, finished: 0 });
    expect(moves).toHaveLength(0);
    expect(jobAudits.map((a) => a.action)).toEqual(['config_move_start', 'config_move_cancel']);
    expect(outbox.map((e) => e.payload)).toEqual([{ tenantId: RESELLER, jobId: job.id }]);
  });

  it('answers another reseller\'s job as job_not_found', async () => {
    const { service } = build();
    const job = await service.start(owner, RESELLER, body());
    await expect(service.job(owner, OTHER, job.id)).rejects.toMatchObject({ reason: 'job_not_found' });
  });
});

describe('configMoveJobSchema', () => {
  it('takes a source panel or 1..500 users, a target, a reason and a requestId — and nothing else', () => {
    const ok = { requestId: randomUUID(), source: { panelId: FROM }, toPanelId: TO, reason: 'outage' };
    expect(configMoveJobSchema.safeParse(ok).success).toBe(true);
    expect(configMoveJobSchema.safeParse({ ...ok, source: { userIds: [randomUUID()] } }).success).toBe(true);
    expect(configMoveJobSchema.safeParse({ ...ok, source: { userIds: [] } }).success).toBe(false);
    expect(configMoveJobSchema.safeParse({ ...ok, source: { panelId: FROM, userIds: [randomUUID()] } }).success).toBe(false);
    expect(configMoveJobSchema.safeParse({ ...ok, reason: '' }).success).toBe(false);
    expect(configMoveJobSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(configMoveJobSchema.safeParse({ ...ok, source: { userIds: Array.from({ length: 501 }, () => randomUUID()) } }).success).toBe(false);
  });
});
