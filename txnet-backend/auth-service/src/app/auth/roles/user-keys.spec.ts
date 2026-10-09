import { runWithTenant } from '@txnet-backend/shared-core';
import { AccessReader } from '../permissions/access.reader';
import { RolesService } from './roles.service';
import { TenantRolesRefused, TenantRolesService } from './tenant-roles.service';

/**
 * A key given to or taken from one person, on top of their role (AC-1-l,
 * ADR-0138). What this spec pins:
 *
 * - **Only a key the giver may grant**: it exists, it is not `*` or a
 *   `platform.` key, and the giver's grant scope holds it — for a take too.
 * - **The authority rule is asked of the person's whole answer** (ADR-0103):
 *   a key given to them counts as theirs.
 * - **A `*` holder is neither widened nor narrowed.**
 * - **Every write is audited with its reason and tells the person** what
 *   actually moved in their answer (`access.changed`, cause `keys_set`); the
 *   same write twice writes nothing.
 */
describe('TenantRolesService — a key given or taken (AC-1-l)', () => {
  const reseller = 'aaaaaaaa-0000-4000-8000-000000000001';
  const giver = { userId: 'u-lead', tenantId: reseller, permissions: ['user.read', 'user.write', 'coupon.manage', 'role.manage'] };
  const keys = (...k: string[]) => k.map((key) => ({ permission: { key } }));

  type Row = { permission: { key: string }; effect: 'give' | 'take'; reason: string; grantedByUserId: string; updatedAt: Date };

  const build = (options: { roleKeys?: string[]; rows?: Row[]; as?: 'owner' | 'member' } = {}) => {
    const rows: Row[] = [...(options.rows ?? [])];
    const written: { audit?: Record<string, unknown>; outbox?: Record<string, unknown> } = {};
    const target = { id: 'u-agent', tenantId: reseller, roleId: 'role-support', role: { name: 'Support', rolePermissions: keys(...(options.roleKeys ?? ['user.read', 'user.write'])) } };
    const tx = {
      $executeRaw: vi.fn(async () => undefined),
      user: { findFirst: vi.fn(async () => target) },
      permission: { findUnique: vi.fn(async ({ where }: { where: { key: string } }) => (where.key === 'no.such' ? null : { id: `perm-${where.key}`, key: where.key })) },
      userPermission: {
        findMany: vi.fn(async () => rows.map((r) => ({ userId: 'u-agent', ...r }))),
        findUnique: vi.fn(async ({ where }: { where: { userId_permissionId: { permissionId: string } } }) =>
          rows.find((r) => `perm-${r.permission.key}` === where.userId_permissionId.permissionId) ?? null,
        ),
        upsert: vi.fn(async ({ create }: { create: { permissionId: string; effect: 'give' | 'take'; reason: string } }) => {
          const key = create.permissionId.slice('perm-'.length);
          const i = rows.findIndex((r) => r.permission.key === key);
          const row = { permission: { key }, effect: create.effect, reason: create.reason, grantedByUserId: 'u-lead', updatedAt: new Date() };
          if (i >= 0) rows[i] = row;
          else rows.push(row);
          return row;
        }),
        deleteMany: vi.fn(async ({ where }: { where: { permissionId: string } }) => {
          const i = rows.findIndex((r) => `perm-${r.permission.key}` === where.permissionId);
          if (i < 0) return { count: 0 };
          rows.splice(i, 1);
          return { count: 1 };
        }),
      },
      adminAuditLog: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => void (written.audit = data)) },
      outboxEvent: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => void (written.outbox = data)) },
    };
    const prisma = {
      ...tx,
      tenant: { findUnique: vi.fn(async () => ({ ownerUserId: 'u-owner', tenantType: 'reseller' })) },
      $transaction: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)),
    };
    const door = {
      for() {
        return this;
      },
      runIncludingPlatform: vi.fn(async (_a: unknown, _t: unknown, _c: string, work: (r: unknown) => Promise<unknown>) =>
        runWithTenant({ id: reseller }, () => work({ id: reseller, slug: 'alpha', as: options.as ?? 'member' })),
      ),
    };
    const service = new TenantRolesService(prisma as never, door as never, new RolesService(prisma as never), new AccessReader(prisma as never));
    return { service, rows, written, tx };
  };

  const refusal = (p: Promise<unknown>) => p.then(() => 'none', (e) => (e instanceof TenantRolesRefused ? e.reason : String(e)));

  it('gives a key the giver holds, with its reason, audited, and tells the person what they gained', async () => {
    const { service, rows, written } = build();
    const answer = await service.setKey(giver, reseller, 'u-agent', 'coupon.manage', { effect: 'give', reason: 'runs the spring sale' }, '1.1.1.1');

    expect(answer.keys).toEqual(expect.arrayContaining(['user.read', 'user.write', 'coupon.manage']));
    expect(rows).toHaveLength(1);
    expect(written.audit).toMatchObject({ action: 'user_permission_set', targetEntityId: 'u-agent', newValue: { key: 'coupon.manage', effect: 'give', reason: 'runs the spring sale' } });
    expect(written.outbox?.payload).toMatchObject({ userId: 'u-agent', cause: 'keys_set', given: ['coupon.manage'], taken: [] });
  });

  it('takes a key the role gives, and the removal wins over the role', async () => {
    const { service, written } = build();
    const answer = await service.setKey(giver, reseller, 'u-agent', 'user.write', { effect: 'take', reason: 'on probation' }, '1.1.1.1');

    expect(answer.keys).toEqual(['user.read']);
    expect(written.outbox?.payload).toMatchObject({ given: [], taken: ['user.write'] });
  });

  it('lifts by hand: the row goes and the person is told what came back', async () => {
    const { service, rows, written } = build({
      rows: [{ permission: { key: 'user.write' }, effect: 'take', reason: 'x', grantedByUserId: 'u-lead', updatedAt: new Date() }],
    });
    const answer = await service.liftKey(giver, reseller, 'u-agent', 'user.write', '1.1.1.1');

    expect(rows).toHaveLength(0);
    expect(answer.keys).toEqual(['user.read', 'user.write']);
    expect(written.audit).toMatchObject({ action: 'user_permission_lift' });
    expect(written.outbox?.payload).toMatchObject({ given: ['user.write'], taken: [] });
  });

  it('writes nothing for the same key, effect and reason twice', async () => {
    const { service, tx } = build({
      rows: [{ permission: { key: 'coupon.manage' }, effect: 'give', reason: 'sale', grantedByUserId: 'u-lead', updatedAt: new Date() }],
    });
    await service.setKey(giver, reseller, 'u-agent', 'coupon.manage', { effect: 'give', reason: 'sale' }, '1.1.1.1');

    expect(tx.userPermission.upsert).not.toHaveBeenCalled();
    expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a key the giver does not hold', 'wallet.manual_adjust', 'key_not_held'],
    ['a key that does not exist', 'no.such', 'key_unknown'],
    ['the wildcard', '*', 'key_not_grantable'],
    ['a platform key', 'platform.tenant.manage', 'key_not_grantable'],
  ])('refuses %s', async (_label, key, reason) => {
    const { service, rows } = build();
    await expect(refusal(service.setKey(giver, reseller, 'u-agent', key, { effect: 'give', reason: 'because' }, '1.1.1.1'))).resolves.toBe(reason);
    expect(rows).toHaveLength(0);
  });

  it('asks authority of the whole answer: a key given to the person makes them no longer below the giver', async () => {
    const { service } = build({
      rows: [{ permission: { key: 'report.read' }, effect: 'give', reason: 'x', grantedByUserId: 'u-owner', updatedAt: new Date() }],
    });
    await expect(refusal(service.setKey(giver, reseller, 'u-agent', 'coupon.manage', { effect: 'give', reason: 'sale' }, '1.1.1.1'))).resolves.toBe(
      'no_authority',
    );
  });

  it('neither widens nor narrows a `*` holder', async () => {
    const { service } = build({ roleKeys: ['*'], as: 'owner' });
    await expect(refusal(service.setKey(giver, reseller, 'u-agent', 'user.write', { effect: 'take', reason: 'x' }, '1.1.1.1'))).resolves.toBe(
      'key_on_wildcard',
    );
  });

  it("reads a person's keys by source: the role's, the given and the taken", async () => {
    const { service } = build({
      rows: [{ permission: { key: 'user.write' }, effect: 'take', reason: 'probation', grantedByUserId: 'u-lead', updatedAt: new Date('2026-10-01') }],
    });
    const view = await service.keysOf(giver, reseller, 'u-agent');

    expect(view).toMatchObject({
      keys: ['user.read'],
      role: { id: 'role-support', name: 'Support', keys: ['user.read', 'user.write'] },
      given: [],
      taken: [{ key: 'user.write', reason: 'probation', by: 'u-lead' }],
    });
  });
});
