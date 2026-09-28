/**
 * A bulk act on Grants chosen by a filter, run as a background job (F-311-u2,
 * spec F-311) — e.g. +3 days to every active Grant on the panel that was down.
 * The act on each Grant is F-311-u's, unchanged (`actOnce`); what this adds,
 * and each case below is a way it breaks quietly:
 *
 *  - **the selection is frozen at the confirm.** The count the admin saw is
 *    what is acted on; a Grant that starts matching a minute later is not;
 *  - **one `requestId`, one job** — a double click answers the same job and
 *    selects nothing again; another body with the id is `request_reused`, and
 *    so is an id a bulk-by-id call already used;
 *  - **each Grant once**, audited as the job's admin, in the job's tenant —
 *    the drain has no request, so the scope is the job's, never ambient;
 *  - **bounded batches**: one drain acts on at most its batch, the next
 *    tick resumes where it stopped;
 *  - a throw nobody named is tried again, then `failed` — never retried for
 *    ever, never a whole job lost; a cancel stops the Grants not yet reached;
 *  - the door is `staffWrite` to start or cancel, `read` to watch;
 *  - **the job itself is audited** (F-311-u3): its start and its cancel are
 *    one admin row each, a repeat or a no-op cancel none;
 *  - **30 days after it ends its per-Grant rows go** (F-311-u3), and the
 *    job's summary stays — a repeat of its `requestId` still acts on nothing.
 */
import { Prisma } from '@prisma/client';
import { ResellerAccess, TenantContext } from '@txnet-backend/shared-core';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';

import { EntitlementRefused } from '../../entitlement/grant';
import { GrantBulkJobDrainService, ResellerGrantBulkJobService } from './grant-bulk-job';
import { GrantBulkFilter, grantBulkJobSchema } from './grant-bulk-job.schema';

type Grant = { id: string; tenantId: string; userId: string; status: string; panels: string[] };
const GRANTS = new Map<string, Grant>();
const calls: { grantId: string; scope: string | undefined; actor: unknown }[] = [];
const throwing = new Map<string, number>();
const scope = () => TenantContext.currentOrNull()?.id;

vi.mock('../../entitlement/duration', () => ({
  changeGrantDuration: async (_tx: unknown, grantId: string, input: { actorUserId: string }) => {
    calls.push({ grantId, scope: scope(), actor: input.actorUserId });
    const left = throwing.get(grantId) ?? 0;
    if (left > 0) {
      throwing.set(grantId, left - 1);
      throw new Error('connection reset');
    }
    if (GRANTS.get(grantId)?.status !== 'active') throw new EntitlementRefused('grant_closed');
    return { changeId: `chg-${grantId}`, endsAtBefore: new Date('2026-10-01T00:00:00Z'), endsAtAfter: new Date('2026-10-04T00:00:00Z'), revived: false };
  },
}));
const audits: { grantId: string | null; actor: string; tenantId: string }[] = [];
const jobAudits: { action: string; jobId: string; actor: string; tenantId: string; reason: string | null; after: unknown }[] = [];
vi.mock('../../grant-audit/grant-audit', () => ({
  auditBulkJob: async (_tx: unknown, actor: { userId: string }, tenantId: string, action: string, jobId: string, _before: unknown, after: unknown, reason: string | null) => {
    jobAudits.push({ action, jobId, actor: actor.userId, tenantId, reason, after });
  },
  auditedGrantAct: async (_tx: unknown, actor: { userId: string }, tenantId: string, grantId: string | null, _spec: unknown, act: () => Promise<unknown>) => {
    const r = await act();
    audits.push({ grantId, actor: actor.userId, tenantId });
    return r;
  },
}));
/** The filter over the fake Grants, as the SQL reads it: the path's tenant, a status named, a live config on the panel. */
const matches = (tenantId: string, f: GrantBulkFilter) => (g: Grant) =>
  g.tenantId === tenantId && f.statuses.includes(g.status as never) && (!f.panelId || g.panels.includes(f.panelId));
vi.mock('./grant-bulk-selection', () => ({
  countSelection: async (_tx: unknown, tenantId: string, filter: GrantBulkFilter) => [...GRANTS.values()].filter(matches(tenantId, filter)).length,
  insertSelection: async (tx: { grantBulkJobItem: { createMany: (a: unknown) => Promise<unknown> } }, jobId: string, tenantId: string, filter: GrantBulkFilter, limit: number) => {
    const ids = [...GRANTS.values()].filter(matches(tenantId, filter)).map((g) => g.id).sort().slice(0, limit);
    await tx.grantBulkJobItem.createMany({ data: ids.map((grantId) => ({ jobId, tenantId, grantId })) });
    return ids.length;
  },
  panelsOfSelection: async (_tx: unknown, tenantId: string) => {
    const on = [...GRANTS.values()].filter((gr) => gr.tenantId === tenantId && ['active', 'suspended'].includes(gr.status)).flatMap((gr) => gr.panels);
    return [...new Set(on)].map((id) => ({ id, name: 'de-2', region: 'de', own: false, retired: false, grants: on.filter((p) => p === id).length }));
  },
}));

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const SUSPENDED = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const OWNER = '55555555-5555-4555-8555-555555555555';
const PANEL = '66666666-6666-4666-8666-666666666666';
const owner = { userId: OWNER, tenantId: PLATFORM, permissions: [] as string[], ip: '203.0.113.7' };
const g = (n: number) => `a${n}a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1`;

type Row = Record<string, unknown>;
const duplicate = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
const pick = (rows: Row[], where: Row = {}) =>
  rows.filter((r) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'NOT') return !Object.entries(v as Row).every(([nk, nv]) => r[nk] === nv);
      if (k === 'job') return Object.entries(v as Row).every(([jk, jv]) => (r.__job as () => Row)()[jk] === jv);
      if (k === 'grantId' && v && typeof v === 'object' && 'in' in (v as Row)) return ((v as { in: string[] }).in).includes(r.grantId as string);
      if (v && typeof v === 'object' && 'not' in (v as Row)) return r[k] !== (v as Row).not;
      return r[k] === v;
    }),
  );
const apply = (r: Row, data: Row) => {
  for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && 'increment' in (v as Row) ? (r[k] as number) + ((v as Row).increment as number) : v;
  return r;
};

function build(batch = 200) {
  GRANTS.clear();
  calls.length = 0;
  audits.length = 0;
  jobAudits.length = 0;
  throwing.clear();
  for (const n of [1, 2, 3]) GRANTS.set(g(n), { id: g(n), tenantId: RESELLER, userId: `u${n}`, status: 'active', panels: [PANEL] });
  GRANTS.set(g(4), { id: g(4), tenantId: RESELLER, userId: 'u4', status: 'active', panels: [] });
  GRANTS.set(g(5), { id: g(5), tenantId: OTHER, userId: 'u5', status: 'active', panels: [PANEL] });

  const jobs: Row[] = [];
  const items: Row[] = [];
  const outcomes: Row[] = [];
  const jobOf = (id: unknown) => jobs.find((j) => j.id === id)!;
  const tenants: Record<string, unknown> = {
    [PLATFORM]: { id: PLATFORM, slug: 'platform', tenantType: 'platform_owner', ownerUserId: null, status: 'active', graceEndsAt: null, deletedAt: null },
    [RESELLER]: { id: RESELLER, slug: 'acme', tenantType: 'reseller', ownerUserId: OWNER, status: 'active', graceEndsAt: null, deletedAt: null },
    [SUSPENDED]: { id: SUSPENDED, slug: 'late', tenantType: 'reseller', ownerUserId: OWNER, status: 'suspended', graceEndsAt: null, deletedAt: null },
  };
  const access = new ResellerAccess({
    tenant: { findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null, findFirst: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null },
    tenantStaffMember: { findFirst: async () => null },
  } as never);
  /** Every tenant read is fenced by the ambient scope, as RLS fences it. */
  const inScope = (rows: Row[]) => rows.filter((r) => scope() === undefined || r.tenantId === scope());
  const tx = {
    $executeRaw: async () => 1,
    grant: {
      findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => {
        const gr = GRANTS.get(where.id);
        return gr && gr.tenantId === where.tenantId && gr.tenantId === scope() ? { id: gr.id, userId: gr.userId } : null;
      },
    },
    grantBulkJob: {
      findUnique: async ({ where }: { where: Row }) => {
        const k = (where.tenantId_requestId as Row) ?? where;
        return pick(inScope(jobs), k)[0] ?? null;
      },
      findFirst: async ({ where }: { where: Row }) => pick(inScope(jobs), where)[0] ?? null,
      findMany: async ({ skip = 0, take = 20 }: { skip?: number; take?: number }) => [...inScope(jobs)].reverse().slice(skip, skip + take),
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
    grantBulkJobItem: {
      createMany: async ({ data }: { data: Row[] }) => {
        for (const d of data) items.push({ attempts: 0, doneAt: null, ok: null, failed: false, ...d, __job: () => jobOf(d.jobId) });
        return { count: data.length };
      },
      findMany: async ({ where, skip = 0, take = 20 }: { where: Row; skip?: number; take?: number }) =>
        pick(inScope(items), where)
          .sort((a, b) => ((a.doneAt as Date)?.getTime() ?? 0) - ((b.doneAt as Date)?.getTime() ?? 0) || String(a.grantId).localeCompare(String(b.grantId)))
          .slice(skip, skip + take),
      count: async ({ where }: { where: Row }) => pick(inScope(items), where).length,
      deleteMany: async ({ where }: { where: Row }) => {
        const hit = new Set(pick(inScope(items), where));
        const kept = items.filter((r) => !hit.has(r));
        items.splice(0, items.length, ...kept);
        return { count: hit.size };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = pick(inScope(items), where);
        hit.forEach((r) => apply(r, data));
        return { count: hit.length };
      },
    },
    grantBulkOutcome: {
      findUnique: async ({ where }: { where: { tenantId_requestId_grantId: Row } }) => pick(outcomes, where.tenantId_requestId_grantId)[0] ?? null,
      findFirst: async ({ where }: { where: Row }) => pick(outcomes, where)[0] ?? null,
      findMany: async ({ where }: { where: Row }) => pick(outcomes, where),
      deleteMany: async ({ where }: { where: Row }) => {
        const hit = new Set(pick(outcomes, where));
        const kept = outcomes.filter((r) => !hit.has(r));
        outcomes.splice(0, outcomes.length, ...kept);
        return { count: hit.size };
      },
      create: async ({ data }: { data: Row }) => {
        if (pick(outcomes, { tenantId: data.tenantId, requestId: data.requestId, grantId: data.grantId }).length) throw duplicate();
        outcomes.push(data);
        return data;
      },
      createMany: async ({ data }: { data: Row[] }) => {
        for (const d of data) if (!pick(outcomes, { tenantId: d.tenantId, requestId: d.requestId, grantId: d.grantId }).length) outcomes.push(d);
        return { count: data.length };
      },
    },
  };
  /** A throw rolls back what the transaction appended, as Postgres would. */
  const prisma = {
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      const at = [jobs.length, items.length, outcomes.length];
      try {
        return await fn(tx);
      } catch (e) {
        jobs.length = at[0];
        items.length = at[1];
        outcomes.length = at[2];
        throw e;
      }
    },
  };
  /** The drain's scan: cross-tenant, no scope — pending items of running jobs, oldest job first. */
  const crossTenant = {
    grantBulkJobItem: {
      findMany: async ({ take }: { take: number }) =>
        items
          .filter((i) => i.doneAt === null && jobOf(i.jobId).status === 'running')
          .sort((a, b) => (jobOf(a.jobId).createdAt as Date).getTime() - (jobOf(b.jobId).createdAt as Date).getTime() || String(a.grantId).localeCompare(String(b.grantId)))
          .slice(0, take)
          .map((i) => ({ jobId: i.jobId, tenantId: i.tenantId, grantId: i.grantId, attempts: i.attempts })),
    },
    grantBulkJob: {
      /** By id for the drain; ended before a cutoff and not yet purged for the purge. */
      findMany: async ({ where }: { where: { id?: { in: string[] }; finishedAt?: { lt: Date } } }) =>
        where.id
          ? jobs.filter((j) => where.id!.in.includes(j.id as string))
          : jobs.filter((j) => j.purgedAt == null && j.finishedAt != null && (j.finishedAt as Date) < where.finishedAt!.lt),
    },
    /** The bulk-by-id outcomes' purge: counted, its SQL is checked against Postgres. */
    $executeRaw: async () => 0,
  };
  const config = { get: (k: string) => ({ GRANT_BULK_JOB_BATCH_SIZE: batch, GRANT_BULK_RETENTION_DAYS: 30 })[k] };
  const service = new ResellerGrantBulkJobService(prisma as never, access);
  const drain = new GrantBulkJobDrainService(prisma as never, crossTenant as never, config as never);
  return { service, drain, jobs, items, outcomes };
}

const days = (filter: Partial<GrantBulkFilter> = {}, requestId = randomUUID()) =>
  grantBulkJobSchema.parse({ requestId, action: 'days', days: 3, reason: 'panel de-2 down 2026-09-27', filter }) as never;

describe('bulk act by filter, as a job (F-311-u2)', () => {
  it('freezes the selection at the confirm: a Grant that matches later is not acted on', async () => {
    const { service, drain } = build();
    expect(await service.count(owner, RESELLER, { panelId: PANEL, statuses: ['active'] })).toBe(3);

    const job = await service.start(owner, RESELLER, days({ panelId: PANEL }));
    expect(job).toMatchObject({ status: 'running', total: 3, processed: 0 });

    GRANTS.set(g(4), { ...GRANTS.get(g(4))!, panels: [PANEL] });
    await drain.drain();

    expect(calls.map((c) => c.grantId).sort()).toEqual([g(1), g(2), g(3)]);
    expect(await service.job(owner, RESELLER, job.id)).toMatchObject({ status: 'done', total: 3, processed: 3, ok: 3, refused: 0, failed: 0 });
  });

  it("acts on each Grant once, in the job's tenant, audited as the job's admin, its outcome kept under the job's requestId", async () => {
    const { service, drain, outcomes } = build();
    const job = await service.start(owner, RESELLER, days({ panelId: PANEL }));
    await drain.drain();
    await drain.drain();

    expect(calls.map((c) => [c.grantId, c.scope, c.actor])).toEqual([g(1), g(2), g(3)].map((id) => [id, RESELLER, OWNER]));
    expect(audits.every((a) => a.actor === OWNER && a.tenantId === RESELLER)).toBe(true);
    expect(outcomes.map((o) => [o.grantId, o.requestId, o.ok])).toEqual([g(1), g(2), g(3)].map((id) => [id, job.requestId, true]));

    const page = await service.outcomes(owner, RESELLER, job.id, { problems: false });
    expect(page.rows[0]).toMatchObject({ grantId: g(1), userId: 'u1', ok: true, result: { endsAtAfter: '2026-10-04T00:00:00.000Z' } });
  });

  it('answers a repeated requestId with the same job and selects nothing again; another body with it is request_reused', async () => {
    const { service, items } = build();
    const req = randomUUID();
    const first = await service.start(owner, RESELLER, days({ panelId: PANEL }, req));
    const again = await service.start(owner, RESELLER, days({ panelId: PANEL }, req));

    expect(again.id).toBe(first.id);
    expect(items).toHaveLength(3);
    await expect(service.start(owner, RESELLER, days({}, req))).rejects.toMatchObject({ reason: 'request_reused' });
  });

  it('refuses a requestId a bulk-by-id call already used, and a filter that matches nothing, creating no job', async () => {
    const { service, outcomes, jobs } = build();
    const req = randomUUID();
    outcomes.push({ tenantId: RESELLER, requestId: req, grantId: g(1), fingerprint: 'by-ids', ok: true, outcome: {} });

    await expect(service.start(owner, RESELLER, days({ panelId: PANEL }, req))).rejects.toMatchObject({ reason: 'request_reused' });
    await expect(service.start(owner, RESELLER, days({ statuses: ['expired'] }))).rejects.toMatchObject({ reason: 'selection_empty' });
    expect(jobs).toHaveLength(0);
  });

  it('acts on at most one batch a drain, and the next drain resumes', async () => {
    const { service, drain } = build(2);
    const job = await service.start(owner, RESELLER, days({ panelId: PANEL }));

    expect(await drain.drain()).toMatchObject({ acted: 2, finished: 0 });
    expect(await service.job(owner, RESELLER, job.id)).toMatchObject({ status: 'running', processed: 2 });
    expect(await drain.drain()).toMatchObject({ acted: 1, finished: 1 });
    expect(calls.map((c) => c.grantId)).toEqual([g(1), g(2), g(3)]);
  });

  it('keeps a refusal as that Grant outcome, retries a throw nobody named, then counts it failed', async () => {
    const { service, drain } = build();
    throwing.set(g(1), 99);
    const job = await service.start(owner, RESELLER, days({ panelId: PANEL }));
    GRANTS.set(g(2), { ...GRANTS.get(g(2))!, status: 'cancelled' });

    await drain.drain(new Date('2026-09-28T10:00:00Z'));
    expect(await service.job(owner, RESELLER, job.id)).toMatchObject({ status: 'running', processed: 2, ok: 1, refused: 1 });
    await drain.drain(new Date('2026-09-28T10:01:00Z'));
    await drain.drain(new Date('2026-09-28T10:02:00Z'));

    expect(calls.filter((c) => c.grantId === g(1))).toHaveLength(3);
    expect(await service.job(owner, RESELLER, job.id)).toMatchObject({ status: 'done', processed: 3, ok: 1, refused: 1, failed: 1 });
    const problems = await service.outcomes(owner, RESELLER, job.id, { problems: true });
    expect(problems.rows).toEqual([
      { grantId: g(2), ok: false, reason: 'grant_closed' },
      { grantId: g(1), ok: false, reason: 'failed' },
    ]);
  });

  it('stops at a cancel: Grants not yet reached are never acted on', async () => {
    const { service, drain } = build(1);
    const job = await service.start(owner, RESELLER, days({ panelId: PANEL }));
    await drain.drain();
    expect(await service.cancel(owner, RESELLER, job.id)).toMatchObject({ status: 'cancelled', processed: 1 });
    await drain.drain();

    expect(calls.map((c) => c.grantId)).toEqual([g(1)]);
  });

  it("names the panels holding the reseller's Grants, with their count, to a suspended reseller too (F-311-x1)", async () => {
    const { service } = build();
    expect(await service.panels(owner, RESELLER)).toEqual([expect.objectContaining({ id: PANEL, grants: 3 })]);
    expect(await service.panels(owner, SUSPENDED)).toEqual([]);
    await expect(service.panels({ ...owner, userId: randomUUID() }, RESELLER)).rejects.toMatchObject({ reason: 'not_allowed' });
  });

  it('lets a suspended reseller watch but not start, and hides another tenant job', async () => {
    const { service } = build();
    await expect(service.start(owner, SUSPENDED, days())).rejects.toMatchObject({ reason: 'reseller_suspended' });
    const job = await service.start(owner, RESELLER, days({ panelId: PANEL }));
    await expect(service.job(owner, SUSPENDED, job.id)).rejects.toMatchObject({ reason: 'job_not_found' });
  });

  it('audits the start and the cancel as one admin row each — a repeat and a no-op cancel write none', async () => {
    const { service, drain } = build();
    const req = randomUUID();
    const job = await service.start(owner, RESELLER, days({ panelId: PANEL }, req));
    await service.start(owner, RESELLER, days({ panelId: PANEL }, req));
    expect(jobAudits).toEqual([
      { action: 'grant_bulk_start', jobId: job.id, actor: OWNER, tenantId: RESELLER, reason: 'panel de-2 down 2026-09-27', after: expect.objectContaining({ action: 'days', total: 3, filter: { panelId: PANEL, statuses: ['active'] } }) },
    ]);

    await service.cancel(owner, RESELLER, job.id);
    await service.cancel(owner, RESELLER, job.id);
    expect(jobAudits.map((a) => a.action)).toEqual(['grant_bulk_start', 'grant_bulk_cancel']);

    const other = await service.start(owner, RESELLER, days({ panelId: PANEL }));
    await drain.drain();
    await service.cancel(owner, RESELLER, other.id);
    expect(jobAudits.filter((a) => a.jobId === other.id).map((a) => a.action)).toEqual(['grant_bulk_start']);
  });

  it("purges an ended job's items and outcomes after 30 days and keeps its summary; a repeat still acts on nothing", async () => {
    const { service, drain, items, outcomes } = build();
    const req = randomUUID();
    const old = await service.start(owner, RESELLER, days({ panelId: PANEL }, req));
    await drain.drain(new Date('2026-08-01T00:00:00Z'));
    const recent = await service.start(owner, RESELLER, days({ statuses: ['active'] }));
    await drain.drain(new Date('2026-09-10T00:00:00Z'));

    expect(await drain.purge(new Date('2026-09-28T00:00:00Z'))).toMatchObject({ jobs: 1 });

    expect(items.filter((i) => i.jobId === old.id)).toEqual([]);
    expect(outcomes.filter((o) => o.requestId === old.requestId)).toEqual([]);
    expect(items.filter((i) => i.jobId === recent.id)).toHaveLength(4);
    expect(await service.job(owner, RESELLER, old.id)).toMatchObject({ status: 'done', total: 3, ok: 3, purgedAt: '2026-09-28T00:00:00.000Z' });
    expect(await service.outcomes(owner, RESELLER, old.id, { problems: false })).toMatchObject({ rows: [], purgedAt: '2026-09-28T00:00:00.000Z' });

    calls.length = 0;
    expect((await service.start(owner, RESELLER, days({ panelId: PANEL }, req))).id).toBe(old.id);
    await drain.drain();
    expect(calls).toEqual([]);
    expect(await drain.purge(new Date('2026-09-28T00:00:00Z'))).toMatchObject({ jobs: 0 });
  });

  it('never purges a running job, however old', async () => {
    const { service, drain, items } = build(1);
    const job = await service.start(owner, RESELLER, days({ panelId: PANEL }));
    await drain.drain(new Date('2026-01-01T00:00:00Z'));

    expect(await drain.purge(new Date('2026-09-28T00:00:00Z'))).toMatchObject({ jobs: 0 });
    expect(items.filter((i) => i.jobId === job.id)).toHaveLength(3);
  });
});
