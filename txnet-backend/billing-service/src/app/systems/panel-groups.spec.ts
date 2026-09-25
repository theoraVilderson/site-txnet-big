/**
 * Panel groups on the systems surface (F-027-bw, network `contract.groups.md`).
 * What would break silently:
 *
 *  - **whose groups.** The owner manages the platform's groups (`tenantId`
 *    null) and nothing else: a tenant's group is `not_found`, a reseller is
 *    refused before anything is read, and a member's panel must be one of the
 *    platform's panels;
 *  - **a strategy nobody built.** `priority` / `weighted` have no fulfilment
 *    (rule 7); the routes never set one, and a body naming it is refused;
 *  - **a user cut off.** Removing a member that still carries a live config of
 *    the group's Grants would orphan those configs outside every drain; it is
 *    refused, and draining is the way out;
 *  - **the drain clock.** Draining twice does not restart the wait, and the
 *    answer states the wait the sweep will hold to.
 */
import { PanelGroupMemberRole, PanelGroupStrategy, Prisma, TenantType } from '@prisma/client';

import { PanelGroupsService } from './panel-groups';
import { createPanelGroupSchema, updatePanelGroupSchema, addPanelGroupMemberSchema } from './panel-registration.schema';
import { PanelScopeRefused } from './panel-scope';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PLATFORM_PANEL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_PANEL = 'abababab-abab-4bab-8bab-abababababab';
const RESELLER_PANEL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GROUP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TENANT_GROUP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'not' in (v as Row)) return row[k] !== (v as { not: unknown }).not;
    return (row[k] ?? null) === v;
  });
}

function harness() {
  const panels: Row[] = [
    { id: PLATFORM_PANEL, tenantId: null, ownershipType: 'platform', name: 'de-fra-1', panelState: 'healthy', reviewState: 'accepted', lastHealthyAt: null },
    { id: SECOND_PANEL, tenantId: null, ownershipType: 'platform', name: 'nl-ams-1', panelState: 'down', reviewState: 'pending', lastHealthyAt: null },
    { id: RESELLER_PANEL, tenantId: RESELLER, ownershipType: 'tenant', name: 'their-own', panelState: 'healthy', reviewState: 'accepted', lastHealthyAt: null },
  ];
  const groups: Row[] = [
    { id: GROUP, tenantId: null, name: 'Europe', strategy: PanelGroupStrategy.mirror, minHealthyPanels: 1, subscriptionTtlSeconds: 3600 },
    { id: TENANT_GROUP, tenantId: RESELLER, name: 'Theirs', strategy: PanelGroupStrategy.mirror, minHealthyPanels: 1, subscriptionTtlSeconds: 3600 },
  ];
  const members: Row[] = [
    { groupId: GROUP, panelId: PLATFORM_PANEL, tenantId: null, priority: 0, weight: 1, role: PanelGroupMemberRole.primary, drainingSince: null },
  ];
  // Panels holding an unretired config of the group's Grants — what the DELETE's NOT EXISTS reads.
  const livePanels = new Set<string>();
  const tenants = new Map([
    [OWNER, TenantType.platform_owner],
    [RESELLER, TenantType.reseller],
  ]);
  const withPanel = (m: Row) => {
    const p = panels.find((x) => x['id'] === m['panelId'])!;
    return { ...m, panel: { name: p['name'], panelState: p['panelState'], reviewState: p['reviewState'], lastHealthyAt: p['lastHealthyAt'] } };
  };
  const withMembers = (g: Row) => ({
    ...g,
    members: members.filter((m) => m['groupId'] === g['id']).map(withPanel),
    _count: { variants: 0 },
  });

  const prisma = {
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        tenants.has(where.id) ? { tenantType: tenants.get(where.id) } : null,
    },
    panel: {
      findFirst: async ({ where }: { where: Row }) => {
        const p = panels.find((row) => matches(row, where));
        return p ? { id: p['id'], name: p['name'] } : null;
      },
    },
  };
  const crossTenant = {
    panelGroup: {
      findMany: async ({ where }: { where: Row }) => groups.filter((g) => matches(g, where)).map(withMembers),
      findFirst: async ({ where }: { where: Row }) => {
        const g = groups.find((row) => matches(row, where));
        return g ? withMembers(g) : null;
      },
      create: async ({ data }: { data: Row }) => {
        const g = { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', strategy: PanelGroupStrategy.mirror, minHealthyPanels: 1,
          subscriptionTtlSeconds: 3600, ...data };
        groups.push(g);
        return withMembers(g);
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = groups.filter((g) => matches(g, where));
        hit.forEach((g) => Object.assign(g, data));
        return { count: hit.length };
      },
    },
    panelGroupMember: {
      findFirst: async ({ where }: { where: Row }) => {
        const m = members.find((row) => matches(row, where));
        return m ? withPanel(m) : null;
      },
      create: async ({ data }: { data: Row }) => {
        if (members.some((m) => m['groupId'] === data['groupId'] && m['panelId'] === data['panelId'])) {
          throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
        }
        const m = { priority: 0, weight: 1, role: PanelGroupMemberRole.primary, drainingSince: null, ...data };
        members.push(m);
        return withPanel(m);
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = members.filter((m) => matches(m, where));
        // The database's clock (`panel_group_member_drain_clock`), as the trigger stamps it.
        hit.forEach((m) => Object.assign(m, data, { drainingSince: new Date('2026-09-25T10:00:00Z') }));
        return { count: hit.length };
      },
    },
    $executeRaw: async (_sql: TemplateStringsArray, groupId: string, panelId: string) => {
      const i = members.findIndex((m) => m['groupId'] === groupId && m['panelId'] === panelId);
      if (i < 0 || livePanels.has(panelId)) return 0;
      members.splice(i, 1);
      return 1;
    },
  };
  return { service: new PanelGroupsService(prisma as never, crossTenant as never), groups, members, livePanels };
}

const owner = { adminId: ADMIN, tenantId: OWNER };
const reseller = { adminId: ADMIN, tenantId: RESELLER };

describe('PanelGroupsService', () => {
  it("lists the platform's groups only, each member with its panel's health", async () => {
    const { service } = harness();
    const list = await service.groups(owner);

    expect(list.map((g) => g.id)).toEqual([GROUP]);
    expect(list[0]).toMatchObject({ name: 'Europe', variantCount: 0 });
    expect(list[0].members).toEqual([
      expect.objectContaining({ panelId: PLATFORM_PANEL, panelName: 'de-fra-1', panelState: 'healthy', reviewState: 'accepted', role: 'primary' }),
    ]);
  });

  it('refuses a reseller before reading or writing a group, on every route', async () => {
    const { service, groups, members } = harness();
    await expect(service.groups(reseller)).rejects.toBeInstanceOf(PanelScopeRefused);
    await expect(service.create(reseller, { name: 'x' })).rejects.toBeInstanceOf(PanelScopeRefused);
    await expect(service.update(reseller, GROUP, { name: 'x' })).rejects.toBeInstanceOf(PanelScopeRefused);
    await expect(service.addMember(reseller, GROUP, { panelId: SECOND_PANEL })).rejects.toBeInstanceOf(PanelScopeRefused);
    await expect(service.removeMember(reseller, GROUP, PLATFORM_PANEL)).rejects.toBeInstanceOf(PanelScopeRefused);
    await expect(service.drain(reseller, GROUP, PLATFORM_PANEL)).rejects.toBeInstanceOf(PanelScopeRefused);
    expect(groups).toHaveLength(2);
    expect(members).toHaveLength(1);
  });

  it('creates a platform group as mirror, whatever it is asked', async () => {
    const { service, groups } = harness();
    const g = await service.create(owner, { name: 'Asia', minHealthyPanels: 2 });

    expect(g).toMatchObject({ name: 'Asia', minHealthyPanels: 2, strategy: PanelGroupStrategy.mirror, members: [] });
    expect(groups[2]).toMatchObject({ tenantId: null });
    expect(createPanelGroupSchema.safeParse({ name: 'x', strategy: 'weighted' }).success).toBe(false);
    expect(createPanelGroupSchema.safeParse({ name: 'x', minHealthyPanels: 0 }).success).toBe(false);
    expect(createPanelGroupSchema.safeParse({ name: 'x', subscriptionTtlSeconds: 0 }).success).toBe(false);
  });

  it("edits a platform group's settings, and answers not_found for a tenant's", async () => {
    const { service, groups } = harness();
    const g = await service.update(owner, GROUP, { subscriptionTtlSeconds: 600 });
    expect(g).toMatchObject({ id: GROUP, subscriptionTtlSeconds: 600, name: 'Europe' });

    await expect(service.update(owner, TENANT_GROUP, { name: 'mine now' })).rejects.toMatchObject({ reason: 'not_found' });
    expect(groups[1]['name']).toBe('Theirs');
    expect(updatePanelGroupSchema.safeParse({}).success).toBe(false);
    expect(updatePanelGroupSchema.safeParse({ tenantId: OWNER }).success).toBe(false);
  });

  it("adds a platform panel once, and never a reseller's panel", async () => {
    const { service, members } = harness();
    const m = await service.addMember(owner, GROUP, { panelId: SECOND_PANEL, priority: 1, weight: 3 });
    expect(m).toMatchObject({ groupId: GROUP, panelId: SECOND_PANEL, panelName: 'nl-ams-1', priority: 1, weight: 3, role: 'primary' });
    expect(members[1]).toMatchObject({ tenantId: null });

    await expect(service.addMember(owner, GROUP, { panelId: SECOND_PANEL })).rejects.toMatchObject({ reason: 'already_member' });
    await expect(service.addMember(owner, GROUP, { panelId: RESELLER_PANEL })).rejects.toMatchObject({ reason: 'panel_not_found' });
    await expect(service.addMember(owner, TENANT_GROUP, { panelId: SECOND_PANEL })).rejects.toMatchObject({ reason: 'not_found' });
    expect(members).toHaveLength(2);
    expect(addPanelGroupMemberSchema.safeParse({ panelId: SECOND_PANEL, role: 'drain' }).success).toBe(false);
    expect(addPanelGroupMemberSchema.safeParse({ panelId: SECOND_PANEL, weight: 0 }).success).toBe(false);
  });

  it('removes a member only when no live config of the group is on it — else it is to be drained', async () => {
    const { service, members, livePanels } = harness();
    livePanels.add(PLATFORM_PANEL);
    await expect(service.removeMember(owner, GROUP, PLATFORM_PANEL)).rejects.toMatchObject({ reason: 'member_has_configs' });
    expect(members).toHaveLength(1);

    livePanels.clear();
    await expect(service.removeMember(owner, GROUP, PLATFORM_PANEL)).resolves.toEqual({ groupId: GROUP, panelId: PLATFORM_PANEL, removed: true });
    expect(members).toHaveLength(0);
    await expect(service.removeMember(owner, GROUP, PLATFORM_PANEL)).rejects.toMatchObject({ reason: 'member_not_found' });
  });

  it('drains a member once, stating the wait, and a second drain does not restart the clock', async () => {
    const { service, members } = harness();
    const m = await service.drain(owner, GROUP, PLATFORM_PANEL);
    expect(m).toMatchObject({ panelId: PLATFORM_PANEL, role: PanelGroupMemberRole.drain, waitSeconds: 7200 });
    expect(m.drainingSince).toEqual(new Date('2026-09-25T10:00:00Z'));

    await expect(service.drain(owner, GROUP, PLATFORM_PANEL)).rejects.toMatchObject({ reason: 'already_draining' });
    await expect(service.drain(owner, GROUP, SECOND_PANEL)).rejects.toMatchObject({ reason: 'member_not_found' });
    expect(members[0]['role']).toBe(PanelGroupMemberRole.drain);
  });
});
