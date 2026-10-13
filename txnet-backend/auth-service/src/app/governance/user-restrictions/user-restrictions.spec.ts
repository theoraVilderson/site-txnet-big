/**
 * A restriction on one person (F-030-d, §3.9): a cap or a bar from the
 * registry (`USER_RESTRICTIONS`), with a value, a reason and an optional
 * expiry, set, changed and lifted by staff holding `restriction.assign`.
 *
 * What would break silently here, and nowhere else:
 *  - a key or a value the enforcement (F-030-e) cannot read stored as if it
 *    meant something — a count out of range, an option that does not exist;
 *  - a restriction set on someone the writer has no authority over
 *    (ADR-0103), or on another tenant's person;
 *  - a change or a lift with no audit row, or the same save twice with two;
 *  - an expired restriction still shown as one that holds.
 */
import { runWithTenant } from '@txnet-backend/shared-core';

import { AccessReader } from '../../auth/permissions/access.reader';
import { UserRestrictionsRefused, UserRestrictionsService } from './user-restrictions.service';

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';
const LEAD = 'u-lead';
const AGENT = 'u-agent';
const BUYER = 'u-buyer';
const NOW = new Date('2026-10-13T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

type Row = { userId: string; tenantId: string; key: string; value: unknown; reason: string; setByUserId: string; expiresAt: Date | null; updatedAt: Date };

function harness(initial: Row[] = [], options: { as?: 'owner' | 'member' } = {}) {
  const rows = [...initial];
  const audit: Record<string, unknown>[] = [];
  const people: Record<string, string[]> = { [AGENT]: ['support.agent', 'coupon.manage'], [BUYER]: [], [LEAD]: ['restriction.assign', 'support.agent', 'user.read'] };
  const person = (id: string) => ({ id, tenantId: TENANT, role: { rolePermissions: (people[id] ?? []).map((key) => ({ permission: { key } })) } });
  const live = (r: Row, where: { OR?: Array<{ expiresAt: null | { gt: Date } }> }) => {
    const gt = where.OR?.find((c) => c.expiresAt !== null)?.expiresAt as { gt: Date } | undefined;
    return !gt || r.expiresAt === null || r.expiresAt > gt.gt;
  };
  const db = {
    $executeRaw: vi.fn(async () => undefined),
    user: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => (where.id in people ? person(where.id) : null)),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, tenantId: TENANT, tenant: { tenantType: 'reseller' } }))),
    },
    userPermission: { findMany: vi.fn(async () => []) },
    userGroupMember: { findMany: vi.fn(async () => []) },
    tenant: { findUnique: vi.fn(async () => ({ ownerUserId: 'u-owner', tenantType: 'reseller' })) },
    userRestriction: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } & Parameters<typeof live>[1] }) => rows.filter((r) => r.userId === where.userId && live(r, where))),
      findUnique: vi.fn(async ({ where }: { where: { userId_key: { userId: string; key: string } } }) => rows.find((r) => r.userId === where.userId_key.userId && r.key === where.userId_key.key) ?? null),
      upsert: vi.fn(async ({ create, update }: { create: Row; update: Partial<Row> }) => {
        const i = rows.findIndex((r) => r.userId === create.userId && r.key === create.key);
        if (i >= 0) rows[i] = { ...rows[i], ...update, updatedAt: NOW };
        else rows.push({ ...create, updatedAt: NOW });
      }),
      delete: vi.fn(async ({ where }: { where: { userId_key: { userId: string; key: string } } }) => {
        rows.splice(rows.findIndex((r) => r.userId === where.userId_key.userId && r.key === where.userId_key.key), 1);
      }),
    },
    adminAuditLog: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => void audit.push(data)) },
  };
  const prisma = { ...db, $transaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(db)) };
  const door = {
    keys: [] as string[],
    for(key: string) {
      this.keys.push(key);
      return this;
    },
    runIncludingPlatform: vi.fn(async (_a: unknown, _t: unknown, _c: string, work: (r: unknown) => Promise<unknown>) =>
      runWithTenant({ id: TENANT }, () => work({ id: TENANT, slug: 'alpha', as: options.as ?? 'member' })),
    ),
  };
  const service = new UserRestrictionsService(prisma as never, door as never, new AccessReader(prisma as never));
  const actor = { userId: LEAD, tenantId: TENANT, permissions: people[LEAD] };
  const set = (userId: string, key: string, input: { value: unknown; reason?: string; expiresAt?: Date | null }) =>
    service.set(actor, TENANT, userId, key, { reason: 'too many chargebacks', ...input }, '127.0.0.1');
  return { service, rows, audit, door, actor, set };
}

const row = (key: string, value: unknown, expiresAt: Date | null = null): Row => ({
  userId: BUYER,
  tenantId: TENANT,
  key,
  value,
  reason: 'too many chargebacks',
  setByUserId: LEAD,
  expiresAt,
  updatedAt: NOW,
});

describe('a restriction on one person (F-030-d)', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('is set with its value, reason and expiry on the person’s tenant, audited, behind restriction.assign', async () => {
    const h = harness();

    const view = await h.set(BUYER, 'services_active_max', { value: 2, expiresAt: new Date(NOW.getTime() + HOUR) });

    expect(h.door.keys).toEqual(['restriction.assign']);
    expect(h.rows).toEqual([expect.objectContaining({ userId: BUYER, tenantId: TENANT, key: 'services_active_max', value: 2, setByUserId: LEAD })]);
    expect(h.audit).toEqual([
      expect.objectContaining({ action: 'user_restriction_set', targetEntityId: BUYER, reason: 'too many chargebacks', oldValue: undefined, newValue: expect.objectContaining({ key: 'services_active_max', value: 2 }) }),
    ]);
    expect(view.restrictions).toEqual([expect.objectContaining({ key: 'services_active_max', value: 2, by: LEAD, expiresAt: new Date(NOW.getTime() + HOUR).toISOString() })]);
    expect(view.keys.map((k) => k.key)).toEqual(['services_active_max', 'configs_max', 'topup_categories_barred']);
  });

  it('keeps a set of barred options sorted, and changes in place with the old value audited', async () => {
    const h = harness([row('topup_categories_barred', ['crypto'])]);

    await h.set(BUYER, 'topup_categories_barred', { value: ['international_card', 'crypto'] });

    expect(h.rows).toEqual([expect.objectContaining({ value: ['crypto', 'international_card'] })]);
    expect(h.audit[0]).toMatchObject({ oldValue: { key: 'topup_categories_barred', value: ['crypto'] } });
  });

  it('writes nothing for the same save twice', async () => {
    const h = harness([row('configs_max', 3)]);

    await h.set(BUYER, 'configs_max', { value: 3 });

    expect(h.audit).toEqual([]);
  });

  it.each([
    ['a key the registry does not hold', 'max_daily_spend', 1, 'restriction_unknown'],
    ['a negative count', 'configs_max', -1, 'restriction_value_invalid'],
    ['a count past its ceiling', 'services_active_max', 10_001, 'restriction_value_invalid'],
    ['a fraction', 'configs_max', 1.5, 'restriction_value_invalid'],
    ['an option that does not exist', 'topup_categories_barred', ['cash'], 'restriction_value_invalid'],
    ['an empty set', 'topup_categories_barred', [], 'restriction_value_invalid'],
  ] as const)('refuses %s', async (_name, key, value, reason) => {
    const h = harness();

    await expect(h.set(BUYER, key, { value })).rejects.toEqual(expect.objectContaining({ reason }));
    expect(h.rows).toEqual([]);
  });

  it('refuses an expiry already past', async () => {
    const h = harness();
    await expect(h.set(BUYER, 'configs_max', { value: 1, expiresAt: new Date(NOW.getTime() - HOUR) })).rejects.toEqual(expect.objectContaining({ reason: 'expiry_past' }));
  });

  it('refuses a person the writer has no authority over, and one not found in the tenant', async () => {
    const h = harness();

    await expect(h.set(AGENT, 'configs_max', { value: 1 })).rejects.toBeInstanceOf(UserRestrictionsRefused);
    await expect(h.set(AGENT, 'configs_max', { value: 1 })).rejects.toEqual(expect.objectContaining({ reason: 'no_authority' }));
    await expect(h.set('u-elsewhere', 'configs_max', { value: 1 })).rejects.toEqual(expect.objectContaining({ reason: 'user_not_found' }));
    await expect(h.set(LEAD, 'configs_max', { value: 1 })).rejects.toEqual(expect.objectContaining({ reason: 'no_authority' }));
  });

  it('is lifted by hand, audited; a second lift finds nothing', async () => {
    const h = harness([row('configs_max', 3)]);

    const view = await h.service.lift(h.actor, TENANT, BUYER, 'configs_max', '127.0.0.1');

    expect(view.restrictions).toEqual([]);
    expect(h.audit).toEqual([expect.objectContaining({ action: 'user_restriction_lift', oldValue: expect.objectContaining({ key: 'configs_max', value: 3 }) })]);
    await expect(h.service.lift(h.actor, TENANT, BUYER, 'configs_max', '127.0.0.1')).rejects.toEqual(expect.objectContaining({ reason: 'restriction_not_found' }));
  });

  it('shows only what holds now: an expired restriction is gone from the list', async () => {
    const h = harness([row('configs_max', 3, new Date(NOW.getTime() - HOUR)), row('services_active_max', 1)]);

    const view = await h.service.list(h.actor, TENANT, BUYER);

    expect(view.restrictions.map((r) => r.key)).toEqual(['services_active_max']);
  });
});
