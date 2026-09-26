/**
 * An admin acts on one user's configs (F-311-g, spec F-307): regenerate,
 * disable, enable, retire or move — 1..50 ids, one outcome per id — for a
 * user of the reseller the **path** names.
 *
 * Each action is still `ConfigActionsService`'s, unchanged but for the actor:
 * `admin`, whose id is the caller. What this surface adds, and each case below
 * is a way it breaks quietly:
 *
 *  - **the door is `staffWrite`.** A suspended reseller still reads its users'
 *    services (F-311-f), but changes nothing — and a refusal writes nothing;
 *  - **the user must be the reseller's** (C-15), decided before any config is
 *    touched, exactly as for the reads;
 *  - **the config must be the path's user's.** An admin actor passes
 *    `ConfigActionsService`'s ownership check for any config, so the fence is
 *    here: another user's config is `config_not_found` and is never acted on;
 *  - **one config's refusal is its own outcome**; its neighbours still run.
 */
import { ActorType } from '@prisma/client';
import { ResellerAccess, TenantContext } from '@txnet-backend/shared-core';

import { ConfigActionRefused } from '../../traffic/config-actions';
import { UserConfigsService } from '../../traffic/user-configs';
import { ResellerUserGrantsService } from './reseller-user-grants.service';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const SUSPENDED = '33333333-3333-4333-8333-333333333333';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '66666666-6666-4666-8666-666666666666';
const NEIGHBOUR = '77777777-7777-4777-8777-777777777777';
const FOREIGN_CUSTOMER = '88888888-8888-4888-8888-888888888888';
const CFG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CFG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CFG_NEIGHBOUR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PANEL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[] };

/** One call into `ConfigActionsService`: the action, its input, and the tenant in scope. */
type Called = { action: string; input: Record<string, unknown>; scope: string | undefined };

function build() {
  const called: Called[] = [];
  const scope = () => TenantContext.currentOrNull()?.id;

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

  // Whose user each id is, found only in its own tenant's scope (RLS).
  const userTenant: Record<string, string> = { [CUSTOMER]: RESELLER, [NEIGHBOUR]: RESELLER, [FOREIGN_CUSTOMER]: SUSPENDED };
  // Whose config each id is.
  const configUser: Record<string, string> = { [CFG_A]: CUSTOMER, [CFG_B]: CUSTOMER, [CFG_NEIGHBOUR]: NEIGHBOUR };
  const tx = {
    $executeRaw: async () => 1,
    user: {
      findFirst: async ({ where }: { where: { id: string } }) => (userTenant[where.id] === scope() ? { id: where.id } : null),
    },
    config: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        configUser[where.id] === where.userId ? { id: where.id } : null,
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };

  const record = (action: string) => async (_tx: unknown, input: Record<string, unknown>) => {
    called.push({ action, input, scope: scope() });
    if (input.configId === CFG_B && action === 'enable') throw new ConfigActionRefused('config_changed', CFG_B);
    if (action === 'move') return { configId: 'new-config', uuid: 'u', retiredConfigId: input.configId };
    return undefined;
  };
  const actions = {
    regenerate: record('regenerate'),
    disable: record('disable'),
    enable: record('enable'),
    retire: record('retire'),
    move: record('move'),
  };
  const configs = new UserConfigsService(prisma as never, actions as never);
  const service = new ResellerUserGrantsService(prisma as never, access, {} as never, configs, {} as never, {} as never);
  return { called, service };
}

const ADMIN = { actorType: ActorType.admin, actorId: OWNER_USER };

describe('ResellerUserGrantsService.act (F-311-g)', () => {
  it("acts as the admin on the path's user's configs, in the reseller's scope, once per id and in order", async () => {
    const { called, service } = build();

    const out = await service.act(owner, RESELLER, CUSTOMER, { action: 'regenerate', configIds: [CFG_B, CFG_A, CFG_B] });

    expect(out).toEqual([
      { configId: CFG_B, ok: true },
      { configId: CFG_A, ok: true },
    ]);
    expect(called).toEqual([
      { action: 'regenerate', input: { configId: CFG_B, actor: ADMIN }, scope: RESELLER },
      { action: 'regenerate', input: { configId: CFG_A, actor: ADMIN }, scope: RESELLER },
    ]);
  });

  it("refuses another user's config of the same reseller as config_not_found, and never acts on it", async () => {
    const { called, service } = build();

    const out = await service.act(owner, RESELLER, CUSTOMER, { action: 'retire', configIds: [CFG_NEIGHBOUR, CFG_A] });

    expect(out).toEqual([
      { configId: CFG_NEIGHBOUR, ok: false, reason: 'config_not_found' },
      { configId: CFG_A, ok: true },
    ]);
    expect(called.map((c) => c.input.configId)).toEqual([CFG_A]);
  });

  it('passes a disable its reason and a move its panel, and answers the moved config', async () => {
    const { called, service } = build();

    await service.act(owner, RESELLER, CUSTOMER, { action: 'disable', configIds: [CFG_A], reason: 'abuse report' });
    const moved = await service.act(owner, RESELLER, CUSTOMER, { action: 'move', configIds: [CFG_A], toPanelId: PANEL });

    expect(called[0]).toMatchObject({ action: 'disable', input: { configId: CFG_A, reason: 'abuse report', actor: ADMIN } });
    expect(called[1]).toMatchObject({ action: 'move', input: { configId: CFG_A, toPanelId: PANEL, actor: ADMIN } });
    expect(moved).toEqual([{ configId: CFG_A, ok: true, movedTo: 'new-config' }]);
  });

  it("answers one config's refusal as its outcome and still runs the others", async () => {
    const { service } = build();
    const out = await service.act(owner, RESELLER, CUSTOMER, { action: 'enable', configIds: [CFG_B, CFG_A] });
    expect(out).toEqual([
      { configId: CFG_B, ok: false, reason: 'config_changed' },
      { configId: CFG_A, ok: true },
    ]);
  });

  it('refuses a suspended reseller — it still reads, but acts on nothing', async () => {
    const { called, service } = build();
    await expect(service.act(owner, SUSPENDED, FOREIGN_CUSTOMER, { action: 'retire', configIds: [CFG_A] })).rejects.toMatchObject({
      reason: 'reseller_suspended',
    });
    expect(called).toEqual([]);
  });

  it('refuses a user of another tenant as user_not_found, before any config', async () => {
    const { called, service } = build();
    await expect(service.act(owner, RESELLER, FOREIGN_CUSTOMER, { action: 'retire', configIds: [CFG_A] })).rejects.toMatchObject({
      reason: 'user_not_found',
    });
    expect(called).toEqual([]);
  });
});
