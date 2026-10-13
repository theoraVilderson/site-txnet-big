/**
 * A key given to one person for a window (F-030-a, ADR-0138 (7)): AC-1-l's
 * give with an optional `startsAt`/`endsAt` on the same row.
 *
 * What would break silently here, and nowhere else:
 *  - a key counted before its start or after its end — the reader is the one
 *    answer every token, the Redis writer and the authority rule share;
 *  - a window that opens or closes with no row written, so the trigger never
 *    moves the token and the person is never told;
 *  - a take with a window, an end already past, or an end before the start,
 *    stored as if it meant something;
 *  - a second run of the sweep (delivery is at-least-once) telling twice.
 */
import { runWithTenant } from '@txnet-backend/shared-core';

import { AccessReader } from '../permissions/access.reader';
import { KeyWindowSweep } from '../permissions/key-window.sweep';
import { RolesService } from './roles.service';
import { TenantRolesRefused, TenantRolesService } from './tenant-roles.service';

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';
const LEAD = 'u-lead';
const AGENT = 'u-agent';
const NOW = new Date('2026-10-13T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

type Row = {
  userId: string;
  permissionId: string;
  tenantId: string;
  effect: 'give' | 'take';
  reason: string;
  grantedByUserId: string;
  startsAt: Date | null;
  endsAt: Date | null;
  openedAt: Date | null;
  updatedAt: Date;
  permission: { key: string };
};

type Where = Record<string, unknown>;

/** Reads back the slice of Prisma's `where` this code writes: AND, OR, equality, null, `lte`, `gt`, `in`. */
function matches(row: Record<string, unknown>, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([field, cond]) => {
    if (field === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    if (field === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    const value = row[field];
    if (cond === null) return value === null;
    if (cond instanceof Date || typeof cond !== 'object') return value instanceof Date ? value.getTime() === (cond as Date).getTime() : value === cond;
    const ops = cond as { lte?: Date; gt?: Date; in?: unknown[] };
    if (ops.in) return ops.in.includes(value);
    if (!(value instanceof Date)) return false;
    return (!ops.lte || value <= ops.lte) && (!ops.gt || value > ops.gt);
  });
}

const row = (key: string, window: Partial<Pick<Row, 'startsAt' | 'endsAt' | 'openedAt'>> = {}): Row => ({
  userId: AGENT,
  permissionId: `perm-${key}`,
  tenantId: TENANT,
  effect: 'give',
  reason: 'covering the night shift',
  grantedByUserId: LEAD,
  startsAt: null,
  endsAt: null,
  openedAt: null,
  updatedAt: NOW,
  permission: { key },
  ...window,
});

function harness(initial: Row[] = []) {
  const rows = [...initial];
  const outbox: Record<string, unknown>[] = [];
  const history: Record<string, unknown>[] = [];
  const target = { id: AGENT, tenantId: TENANT, roleId: 'role-support', role: { name: 'Support', rolePermissions: [{ permission: { key: 'user.read' } }] } };
  const db = {
    $executeRaw: vi.fn(async () => undefined),
    user: { findFirst: vi.fn(async () => target), findMany: vi.fn(async () => [{ ...target, tenant: { tenantType: 'reseller' } }]) },
    userGroupMember: { findMany: vi.fn(async () => []) },
    permission: { findUnique: vi.fn(async ({ where }: { where: { key: string } }) => ({ id: `perm-${where.key}`, key: where.key })) },
    tenant: { findUnique: vi.fn(async () => ({ ownerUserId: LEAD, tenantType: 'reseller' })) },
    userPermission: {
      findMany: vi.fn(async ({ where, take }: { where?: Where; take?: number }) => rows.filter((r) => matches(r, where)).slice(0, take ?? rows.length)),
      findUnique: vi.fn(async ({ where }: { where: { userId_permissionId: { permissionId: string } } }) => rows.find((r) => r.permissionId === where.userId_permissionId.permissionId) ?? null),
      upsert: vi.fn(async ({ create, update }: { create: Row; update: Partial<Row> }) => {
        const i = rows.findIndex((r) => r.permissionId === create.permissionId);
        if (i >= 0) rows[i] = { ...rows[i], ...update };
        else rows.push({ ...row(create.permissionId.slice('perm-'.length)), ...create });
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const gone = rows.filter((r) => matches(r, where));
        for (const r of gone) rows.splice(rows.indexOf(r), 1);
        return { count: gone.length };
      }),
    },
    adminAuditLog: { create: vi.fn(async () => ({ id: 'act-1' })) },
    accessHistory: { createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => void history.push(...data)) },
    outboxEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => void outbox.push(data)),
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => void outbox.push(...data)),
    },
  };
  const prisma = { ...db, $transaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(db)) };
  const door = {
    for() {
      return this;
    },
    runIncludingPlatform: vi.fn(async (_a: unknown, _t: unknown, _c: string, work: (r: unknown) => Promise<unknown>) =>
      runWithTenant({ id: TENANT }, () => work({ id: TENANT, slug: 'alpha', as: 'owner' })),
    ),
  };
  const answers = new AccessReader(prisma as never);
  const service = new TenantRolesService(prisma as never, door as never, new RolesService(prisma as never), answers);
  const sweep = new KeyWindowSweep(prisma as never, prisma as never, answers);
  const actor = { userId: LEAD, tenantId: TENANT, permissions: ['role.manage'] };
  const give = (key: string, window: { startsAt?: Date; endsAt?: Date } = {}, effect: 'give' | 'take' = 'give') =>
    service.setKey(actor, TENANT, AGENT, key, { effect, reason: 'covering the night shift', ...window }, '127.0.0.1');
  const keysAt = async (when: Date) => (await answers.ofLoadedMany([target], prisma as never, when)).get(AGENT)?.keys.sort();
  return { rows, outbox, history, give, sweep, keysAt };
}

describe('a key given for a window (F-030-a)', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('counts only from its start until its end', async () => {
    const h = harness([row('report.read', { startsAt: at(1), endsAt: at(3) })]);

    expect(await h.keysAt(NOW)).toEqual(['user.read']);
    expect(await h.keysAt(at(2))).toEqual(['report.read', 'user.read']);
    expect(await h.keysAt(at(3))).toEqual(['user.read']);
  });

  it('is stored with its window and shown with it', async () => {
    const h = harness();

    const view = await h.give('report.read', { startsAt: at(1), endsAt: at(5) });

    expect(h.rows[0]).toMatchObject({ startsAt: at(1), endsAt: at(5), openedAt: null });
    expect(view.given).toEqual([expect.objectContaining({ key: 'report.read', startsAt: at(1).toISOString(), endsAt: at(5).toISOString() })]);
    // Not yet live: the answer has not moved, so nothing is promised.
    expect(view.keys).toEqual(['user.read']);
  });

  it('opens at once when its start is not in the future', async () => {
    const h = harness();

    const view = await h.give('report.read', { startsAt: at(-1), endsAt: at(5) });

    expect(h.rows[0]).toMatchObject({ startsAt: null, endsAt: at(5) });
    expect(view.keys.sort()).toEqual(['report.read', 'user.read']);
  });

  it.each([
    ['a take with a window', { endsAt: at(5) }, 'take', 'window_on_take'],
    ['an end already past', { endsAt: at(-1) }, 'give', 'window_past'],
    ['an end before its start', { startsAt: at(5), endsAt: at(2) }, 'give', 'window_inverted'],
  ] as const)('refuses %s', async (_name, window, effect, reason) => {
    const h = harness();

    await expect(h.give('report.read', window, effect)).rejects.toEqual(expect.objectContaining({ reason }));
    await expect(h.give('report.read', window, effect)).rejects.toBeInstanceOf(TenantRolesRefused);
    expect(h.rows).toEqual([]);
  });

  it('opens at its start: the row is marked, so the trigger moves the token, and the person is told what they gained', async () => {
    const h = harness([row('report.read', { startsAt: at(-1), endsAt: at(3) })]);

    await expect(h.sweep.moveDue(NOW)).resolves.toEqual({ opened: 1, closed: 0, told: 1 });

    expect(h.rows[0].openedAt).toEqual(NOW);
    expect(h.outbox).toEqual([expect.objectContaining({ aggregateId: AGENT, payload: { userId: AGENT, tenantId: TENANT, cause: 'key_window', given: ['report.read'], taken: [] } })]);
    // Nobody acted at the moment it opened: the history names who gave it, with no audit row.
    expect(h.history).toEqual([expect.objectContaining({ cause: 'key_window', actorUserId: LEAD, auditLogId: null, given: ['report.read'] })]);
  });

  it('closes at its end: the row is removed and the person is told what they lost', async () => {
    const h = harness([row('report.read', { endsAt: at(-1) })]);

    await expect(h.sweep.moveDue(NOW)).resolves.toEqual({ opened: 0, closed: 1, told: 1 });

    expect(h.rows).toEqual([]);
    expect(h.outbox).toEqual([expect.objectContaining({ payload: expect.objectContaining({ cause: 'key_window', given: [], taken: ['report.read'] }) })]);
  });

  it('leaves a window still running, and a key given with no window', async () => {
    const h = harness([row('report.read', { startsAt: at(1), endsAt: at(3) }), row('coupon.manage')]);

    await expect(h.sweep.moveDue(NOW)).resolves.toEqual({ opened: 0, closed: 0, told: 0 });
    expect(h.rows).toHaveLength(2);
  });

  it('tells once: a second run finds nothing', async () => {
    const h = harness([row('report.read', { startsAt: at(-2), endsAt: at(3) }), row('coupon.manage', { endsAt: at(-1) })]);

    await expect(h.sweep.moveDue(NOW)).resolves.toEqual({ opened: 1, closed: 1, told: 1 });
    await expect(h.sweep.moveDue(NOW)).resolves.toEqual({ opened: 0, closed: 0, told: 0 });
    expect(h.outbox).toHaveLength(1);
  });
});
