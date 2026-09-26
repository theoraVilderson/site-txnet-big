/**
 * An inbound is the default pool's or one group's (F-027-ch, ADR-0090
 * decision 3). What would break silently:
 *
 *  - **two groups selling one inbound** — each counts its own configs against
 *    one inbound's cap, and a move meant for one reaches the other;
 *  - **an inbound taken from under live configs** — another group's buyers
 *    stay on an inbound that no longer sells to them, so it is refused, with
 *    the count, until they are moved or drained;
 *  - **a membership with an assignment still selling the pool**, or one with
 *    none selling nothing — an assignment replaces the pool, never adds to it;
 *  - **the pool keeping an assigned inbound** — every other group would still
 *    place on it.
 */
import { ConfigProtocol, Prisma, TenantType } from '@prisma/client';

import { sellingInbounds } from '../traffic/selling-settings';
import { MemberInboundsService } from './member-inbounds';
import { assignMemberInboundsSchema } from './panel-registration.schema';
import { PanelScopeRefused } from './panel-scope';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PANEL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_GROUP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

type Row = Record<string, unknown>;

function harness(opts: { liveElsewhere?: Record<string, number>; raceOn?: string } = {}) {
  const groups: Row[] = [
    { id: GROUP, tenantId: null, name: 'EU' },
    { id: OTHER_GROUP, tenantId: null, name: 'Gaming' },
  ];
  const members: Row[] = [
    { groupId: GROUP, panelId: PANEL },
    { groupId: OTHER_GROUP, panelId: PANEL },
  ];
  const inbound = (remoteId: string, extra: Row = {}): Row => ({ panelId: PANEL, remoteId, protocol: ConfigProtocol.vless, goneAt: null, ...extra });
  const inbounds: Row[] = [inbound('1'), inbound('2'), inbound('3'), inbound('4', { protocol: null }), inbound('5', { goneAt: new Date() })];
  // Inbound 3 is already the other group's.
  const assignments: Row[] = [{ groupId: OTHER_GROUP, panelId: PANEL, inboundRemoteId: '3' }];
  const locks: string[] = [];
  const queries: string[] = [];
  const match = (r: Row, where: Row) => Object.entries(where).every(([k, v]) => (r[k] ?? null) === v);

  const prisma = {
    tenant: { findUnique: async ({ where }: { where: { id: string } }) => ({ tenantType: where.id === OWNER ? TenantType.platform_owner : TenantType.reseller }) },
  };
  const db = {
    panelGroup: { findFirst: async ({ where }: { where: Row }) => groups.find((g) => match(g, where)) ?? null },
    panelGroupMember: { findFirst: async ({ where }: { where: Row }) => members.find((m) => match(m, where)) ?? null },
    panelInbound: {
      findMany: async ({ where }: { where: { panelId: string; remoteId: { in: string[] } } }) =>
        inbounds.filter((i) => i.panelId === where.panelId && where.remoteId.in.includes(i.remoteId as string)),
    },
    panelGroupMemberInbound: {
      findMany: async ({ where }: { where: { panelId: string; groupId?: string | { not: string }; inboundRemoteId?: { in: string[] } } }) =>
        assignments
          .filter((a) => a.panelId === where.panelId)
          .filter((a) => (typeof where.groupId === 'string' ? a.groupId === where.groupId : where.groupId ? a.groupId !== where.groupId.not : true))
          .filter((a) => !where.inboundRemoteId || where.inboundRemoteId.in.includes(a.inboundRemoteId as string))
          .map((a) => ({ ...a, member: { group: groups.find((g) => g.id === a.groupId) } })),
      deleteMany: async ({ where }: { where: { groupId: string; panelId: string; inboundRemoteId: { notIn: string[] } } }) => {
        const gone = assignments.filter((a) => a.groupId === where.groupId && a.panelId === where.panelId && !where.inboundRemoteId.notIn.includes(a.inboundRemoteId as string));
        for (const a of gone) assignments.splice(assignments.indexOf(a), 1);
        return { count: gone.length };
      },
      createMany: async ({ data }: { data: Row[] }) => {
        if (opts.raceOn && data.some((d) => d.inboundRemoteId === opts.raceOn)) {
          throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
        }
        for (const d of data) if (!assignments.some((a) => match(a, d))) assignments.push(d);
        return { count: data.length };
      },
    },
    $executeRaw: async (_s: TemplateStringsArray, key: string) => {
      locks.push(key);
      return 1;
    },
    // Live configs of other groups, per inbound.
    $queryRaw: async (sql: TemplateStringsArray) => (queries.push(sql.join('?')), Object.entries(opts.liveElsewhere ?? {}).map(([inboundRemoteId, n]) => ({ inboundRemoteId, configs: BigInt(n) }))),
  };
  const crossTenant = { ...db, $transaction: async (work: (tx: typeof db) => Promise<unknown>) => work(db) };
  return { service: new MemberInboundsService(prisma as never, crossTenant as never), assignments, locks, queries };
}

const owner = { adminId: ADMIN, tenantId: OWNER };
const mine = (assignments: Row[]) => assignments.filter((a) => a.groupId === GROUP).map((a) => a.inboundRemoteId).sort();

describe('MemberInboundsService.assign', () => {
  it('gives the membership exactly the inbounds named, under the lock fulfilment takes on the panel', async () => {
    const { service, assignments, locks } = harness();
    const view = await service.assign(owner, GROUP, PANEL, ['2', '1']);

    expect(view).toEqual({ groupId: GROUP, panelId: PANEL, inbounds: ['1', '2'] });
    expect(mine(assignments)).toEqual(['1', '2']);
    expect(locks).toEqual([`panel_inbound:${PANEL}`]);
  });

  it('replaces the set: an inbound left out goes back to the pool, and an empty list sells the pool again', async () => {
    const { service, assignments } = harness();
    await service.assign(owner, GROUP, PANEL, ['1', '2']);
    await service.assign(owner, GROUP, PANEL, ['2']);
    expect(mine(assignments)).toEqual(['2']);

    await expect(service.assign(owner, GROUP, PANEL, [])).resolves.toMatchObject({ inbounds: [] });
    expect(mine(assignments)).toEqual([]);
    // The other group's is untouched.
    expect(assignments).toEqual([{ groupId: OTHER_GROUP, panelId: PANEL, inboundRemoteId: '3' }]);
  });

  it('refuses an inbound another group holds, naming that group', async () => {
    const { service, assignments } = harness();
    await expect(service.assign(owner, GROUP, PANEL, ['1', '3'])).rejects.toMatchObject({
      reason: 'inbound_assigned_elsewhere',
      remoteId: '3',
      group: { id: OTHER_GROUP, name: 'Gaming' },
    });
    expect(mine(assignments)).toEqual([]);
  });

  it('refuses an inbound with live configs of another group, with their count', async () => {
    const { service, assignments } = harness({ liveElsewhere: { '2': 7 } });
    await expect(service.assign(owner, GROUP, PANEL, ['1', '2'])).rejects.toMatchObject({ reason: 'inbound_has_configs', remoteId: '2', configs: 7 });
    expect(mine(assignments)).toEqual([]);
  });

  it('counts a client placed before F-114-b whose inbound is not written down yet, if it could be on this one', async () => {
    const { service, queries } = harness();
    await service.assign(owner, GROUP, PANEL, ['1']);
    // Its row names no inbound; the pass records the one its client is on. Until then any of its protocol may be it.
    expect(queries[0]).toContain('c."inboundRemoteId" IS NULL AND c."remoteId" IS NOT NULL AND c."protocol" = i."protocol"');
  });

  it('answers a concurrent assignment that won the unique index as the same refusal', async () => {
    const { service } = harness({ raceOn: '1' });
    await expect(service.assign(owner, GROUP, PANEL, ['1'])).rejects.toMatchObject({ reason: 'inbound_assigned_elsewhere', remoteId: null, group: null });
  });

  it('assigns only an inbound the read found and a buyer can be placed on', async () => {
    const { service } = harness();
    await expect(service.assign(owner, GROUP, PANEL, ['9'])).rejects.toMatchObject({ reason: 'inbound_not_found' });
    await expect(service.assign(owner, GROUP, PANEL, ['4'])).rejects.toMatchObject({ reason: 'inbound_not_sellable' });
    await expect(service.assign(owner, GROUP, PANEL, ['5'])).rejects.toMatchObject({ reason: 'inbound_not_sellable' });
  });

  it('reaches only a member of a group in scope, and only for the platform owner', async () => {
    const { service } = harness();
    await expect(service.assign(owner, GROUP, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ['1'])).rejects.toMatchObject({ reason: 'member_not_found' });
    await expect(service.assign(owner, 'ffffffff-ffff-4fff-8fff-ffffffffffff', PANEL, ['1'])).rejects.toMatchObject({ reason: 'not_found' });
    await expect(service.assign({ adminId: ADMIN, tenantId: RESELLER }, GROUP, PANEL, ['1'])).rejects.toBeInstanceOf(PanelScopeRefused);
  });
});

describe('sellingInbounds', () => {
  const pool = [{ remoteId: '1', protocol: ConfigProtocol.vless, maxClients: null }];
  const assigned = (remoteId: string, extra: Row = {}) => ({ inbound: { remoteId, protocol: ConfigProtocol.trojan, maxClients: 5, enabled: true, goneAt: null, ...extra } });

  it('sells the pool while the membership has no assignment', () => {
    expect(sellingInbounds({ inbounds: [], panel: { inbounds: pool } })).toEqual(pool);
  });

  it('sells only its own inbounds once it has one — never the pool, and not a disabled, gone or unsold-protocol one', () => {
    const member = {
      inbounds: [assigned('7'), assigned('8', { enabled: false }), assigned('9', { goneAt: new Date() }), assigned('6', { protocol: null })],
      panel: { inbounds: pool },
    };
    expect(sellingInbounds(member)).toEqual([{ remoteId: '7', protocol: ConfigProtocol.trojan, maxClients: 5 }]);
  });

  it('sells nothing, not the pool, when every assigned inbound is disabled', () => {
    expect(sellingInbounds({ inbounds: [assigned('8', { enabled: false })], panel: { inbounds: pool } })).toEqual([]);
  });
});

describe('assignMemberInboundsSchema', () => {
  it('takes a list of the panel\'s own ids, each once, and nothing else', () => {
    expect(assignMemberInboundsSchema.safeParse({ inbounds: ['1', '2'] }).success).toBe(true);
    expect(assignMemberInboundsSchema.safeParse({ inbounds: [] }).success).toBe(true);
    expect(assignMemberInboundsSchema.safeParse({ inbounds: ['1', '1'] }).success).toBe(false);
    expect(assignMemberInboundsSchema.safeParse({ inbounds: ['1'], sold: true }).success).toBe(false);
    expect(assignMemberInboundsSchema.safeParse({ inbounds: Array.from({ length: 501 }, (_, i) => `${i}`) }).success).toBe(false);
  });
});
