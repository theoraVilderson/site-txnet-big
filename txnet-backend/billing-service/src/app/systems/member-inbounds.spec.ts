/**
 * An inbound is sold by every group or by the groups it lists (F-027-ep,
 * ADR-0127 decisions 1-2; amends F-027-ch). What would break silently:
 *
 *  - **a shared inbound refused** — a User Manager router's OpenVPN sold by two
 *    groups is the case the ADR exists for; listing it to a second membership
 *    is never `inbound_assigned_elsewhere` any more;
 *  - **a membership with a listing losing the every-group ones** — a member
 *    sells its listed inbounds *plus* the panel's `every_group` ones;
 *  - **an inbound taken from under live configs** — a group that would stop
 *    selling an inbound its Grants' configs are on is refused, with the group
 *    and the count, until they are moved or emptied (F-027-es);
 *  - **a later group gaining a listed inbound** — only `every_group` reaches a
 *    membership that lists nothing;
 *  - **a group's share lost on a re-save** — a listing's `maxClients` (F-027-eq)
 *    stays while the listing does, and is set only on a listing.
 */
import { ConfigProtocol, InboundAudience, Prisma, TenantType } from '@prisma/client';

import { sanitizeError } from '@txnet-backend/shared-core';

import { sellingInbounds } from '../traffic/selling-settings';
import { InboundHeldElsewhere, MemberInboundsService } from './member-inbounds';
import { PanelAlreadyRegistered } from './panel-address';
import { assignMemberInboundsSchema, setInboundAudienceSchema, setListingShareSchema } from './panel-registration.schema';
import { PanelScopeRefused } from './panel-scope';
import { refusing } from './systems-refusals';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PANEL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_GROUP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const THIRD_GROUP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3';

type Row = Record<string, unknown>;

/**
 * One panel with three member groups. Inbound 3 is listed to the other group;
 * 1, 2 are every group's; 4 sells no protocol, 5 is gone. `live` is the
 * configs a group's Grants hold on an inbound, keyed `remoteId:groupId`.
 */
function harness(opts: { live?: Record<string, number> } = {}) {
  const groups: Row[] = [
    { id: GROUP, tenantId: null, name: 'EU' },
    { id: OTHER_GROUP, tenantId: null, name: 'Gaming' },
    { id: THIRD_GROUP, tenantId: null, name: 'Asia' },
  ];
  const members: Row[] = [GROUP, OTHER_GROUP, THIRD_GROUP].map((groupId) => ({ groupId, panelId: PANEL }));
  const inbound = (remoteId: string, extra: Row = {}): Row => ({ panelId: PANEL, remoteId, protocol: ConfigProtocol.vless, goneAt: null, audience: InboundAudience.every_group, ...extra });
  const inbounds: Row[] = [inbound('1'), inbound('2'), inbound('3', { audience: InboundAudience.listed }), inbound('4', { protocol: null }), inbound('5', { goneAt: new Date() })];
  const listings: Row[] = [{ groupId: OTHER_GROUP, panelId: PANEL, inboundRemoteId: '3' }];
  const locks: string[] = [];
  const asked: { remoteIds: string[]; groupIds: string[] }[] = [];
  const match = (r: Row, where: Row) => Object.entries(where).every(([k, v]) => (r[k] ?? null) === v);
  const inList = (v: unknown, cond: unknown) =>
    cond === undefined ? true : typeof cond === 'string' ? v === cond : 'in' in (cond as Row) ? ((cond as { in: unknown[] }).in).includes(v) : !((cond as { notIn: unknown[] }).notIn).includes(v);

  const prisma = {
    tenant: { findUnique: async ({ where }: { where: { id: string } }) => ({ tenantType: where.id === OWNER ? TenantType.platform_owner : TenantType.reseller }) },
  };
  const db = {
    panel: { findFirst: async ({ where }: { where: Row }) => (where.id === PANEL ? { id: PANEL } : null) },
    panelGroup: { findFirst: async ({ where }: { where: Row }) => groups.find((g) => match(g, where)) ?? null },
    panelGroupMember: {
      findFirst: async ({ where }: { where: Row }) => members.find((m) => match(m, where)) ?? null,
      findMany: async ({ where }: { where: Row }) => members.filter((m) => match(m, where)),
    },
    panelInbound: {
      findMany: async ({ where }: { where: { panelId: string; remoteId: { in: string[] } } }) =>
        inbounds.filter((i) => i.panelId === where.panelId && where.remoteId.in.includes(i.remoteId as string)),
      findUnique: async ({ where }: { where: { panelId_remoteId: { panelId: string; remoteId: string } } }) =>
        inbounds.find((i) => match(i, where.panelId_remoteId)) ?? null,
      updateMany: async ({ where, data }: { where: { panelId: string; remoteId: unknown }; data: Row }) => {
        const hit = inbounds.filter((i) => i.panelId === where.panelId && inList(i.remoteId, where.remoteId));
        for (const i of hit) Object.assign(i, data);
        return { count: hit.length };
      },
    },
    panelGroupMemberInbound: {
      findMany: async ({ where }: { where: { panelId: string; groupId?: string; inboundRemoteId?: string } }) =>
        listings.filter((l) => l.panelId === where.panelId && inList(l.groupId, where.groupId) && inList(l.inboundRemoteId, where.inboundRemoteId)),
      deleteMany: async ({ where }: { where: { panelId: string; groupId?: unknown; inboundRemoteId?: unknown } }) => {
        const gone = listings.filter((l) => l.panelId === where.panelId && inList(l.groupId, where.groupId) && inList(l.inboundRemoteId, where.inboundRemoteId));
        for (const l of gone) listings.splice(listings.indexOf(l), 1);
        return { count: gone.length };
      },
      createMany: async ({ data }: { data: Row[] }) => {
        for (const d of data) if (!listings.some((l) => match(l, d))) listings.push(d);
        return { count: data.length };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = listings.filter((l) => match(l, where));
        for (const l of hit) Object.assign(l, data);
        return { count: hit.length };
      },
    },
    $executeRaw: async (_s: TemplateStringsArray, key: string) => {
      locks.push(key);
      return 1;
    },
    // The live configs of the losing (inbound, group) pairs, as the SQL pairs them.
    $queryRaw: async (_s: TemplateStringsArray, remoteIds: string[], groupIds: string[]) => {
      asked.push({ remoteIds, groupIds });
      return remoteIds.flatMap((remoteId, n) => {
        const configs = opts.live?.[`${remoteId}:${groupIds[n]}`];
        const group = groups.find((g) => g.id === groupIds[n]);
        return configs ? [{ remoteId, groupId: groupIds[n], groupName: group?.name, configs: BigInt(configs) }] : [];
      });
    },
  };
  const crossTenant = { ...db, $transaction: async (work: (tx: typeof db) => Promise<unknown>) => work(db) };
  const audienceOf = (remoteId: string) => inbounds.find((i) => i.remoteId === remoteId)?.audience;
  const listedTo = (remoteId: string) => listings.filter((l) => l.inboundRemoteId === remoteId).map((l) => l.groupId).sort();
  return { service: new MemberInboundsService(prisma as never, crossTenant as never), listings, locks, asked, audienceOf, listedTo };
}

const owner = { adminId: ADMIN, tenantId: OWNER };
const mine = (listings: Row[]) => listings.filter((l) => l.groupId === GROUP).map((l) => l.inboundRemoteId).sort();

describe('MemberInboundsService.assign — the membership\'s listings', () => {
  it('lists exactly the inbounds named, under the lock fulfilment takes on the panel', async () => {
    const { service, listings, locks } = harness();
    const view = await service.assign(owner, GROUP, PANEL, ['3', '1']);

    expect(view).toEqual({ groupId: GROUP, panelId: PANEL, inbounds: ['1', '3'] });
    expect(mine(listings)).toEqual(['1', '3']);
    expect(locks).toEqual([`panel_inbound:${PANEL}`]);
  });

  it('shares a listed inbound: a User Manager router listed to two groups is sold by both, the other keeps its listing', async () => {
    const { service, listedTo, audienceOf } = harness();
    await service.assign(owner, GROUP, PANEL, ['3']);

    expect(listedTo('3')).toEqual([GROUP, OTHER_GROUP].sort());
    expect(audienceOf('3')).toBe(InboundAudience.listed);
  });

  it('naming an every-group inbound lists it to this group alone, refused while another group\'s configs are on it', async () => {
    const refused = harness({ live: { [`1:${THIRD_GROUP}`]: 4 } });
    await expect(refused.service.assign(owner, GROUP, PANEL, ['1'])).rejects.toMatchObject({
      reason: 'inbound_has_configs',
      remoteId: '1',
      group: { id: THIRD_GROUP, name: 'Asia' },
      configs: 4,
    });
    expect(refused.audienceOf('1')).toBe(InboundAudience.every_group);
    expect(mine(refused.listings)).toEqual([]);
    // Every other member of the panel was asked about, never the group gaining it.
    expect(refused.asked[0]).toEqual({ remoteIds: ['1', '1'], groupIds: [OTHER_GROUP, THIRD_GROUP] });

    const { service, audienceOf, listedTo } = harness();
    await service.assign(owner, GROUP, PANEL, ['1']);
    expect(audienceOf('1')).toBe(InboundAudience.listed);
    expect(listedTo('1')).toEqual([GROUP]);
  });

  it('refuses taking a listing off while the group\'s own configs are on it, and leaves the inbound listed to nobody once allowed', async () => {
    const held = harness({ live: { [`3:${OTHER_GROUP}`]: 7 } });
    await expect(held.service.assign(owner, OTHER_GROUP, PANEL, [])).rejects.toMatchObject({ reason: 'inbound_has_configs', remoteId: '3', configs: 7 });
    expect(held.listedTo('3')).toEqual([OTHER_GROUP]);

    const { service, listedTo, audienceOf } = harness();
    await expect(service.assign(owner, OTHER_GROUP, PANEL, [])).resolves.toMatchObject({ inbounds: [] });
    // Never quietly every group's: that would add sellers no one chose (ADR-0127 decision 1).
    expect(listedTo('3')).toEqual([]);
    expect(audienceOf('3')).toBe(InboundAudience.listed);
  });

  it('lists only an inbound the read found and a buyer can be placed on', async () => {
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

describe('MemberInboundsService.setAudience — who sells one inbound', () => {
  it('lists an every-group inbound to chosen groups; the group left out is asked about its configs', async () => {
    const { service, listedTo, audienceOf, asked } = harness();
    const view = await service.setAudience(owner, PANEL, '2', { audience: InboundAudience.listed, groups: [OTHER_GROUP, GROUP] });

    expect(view).toEqual({ panelId: PANEL, remoteId: '2', audience: InboundAudience.listed, groups: [GROUP, OTHER_GROUP].sort() });
    expect(listedTo('2')).toEqual([GROUP, OTHER_GROUP].sort());
    expect(audienceOf('2')).toBe(InboundAudience.listed);
    expect(asked[0]).toEqual({ remoteIds: ['2'], groupIds: [THIRD_GROUP] });
  });

  it('refuses a group losing it with live configs there, naming it', async () => {
    const { service, listedTo } = harness({ live: { [`3:${OTHER_GROUP}`]: 2 } });
    await expect(service.setAudience(owner, PANEL, '3', { audience: InboundAudience.listed, groups: [GROUP] })).rejects.toMatchObject({
      reason: 'inbound_has_configs',
      group: { id: OTHER_GROUP, name: 'Gaming' },
      configs: 2,
    });
    expect(listedTo('3')).toEqual([OTHER_GROUP]);
  });

  it('gives a listed inbound back to every group: its listings go, and nobody loses it', async () => {
    const { service, listedTo, audienceOf, asked } = harness({ live: { [`3:${OTHER_GROUP}`]: 9 } });
    await expect(service.setAudience(owner, PANEL, '3', { audience: InboundAudience.every_group })).resolves.toMatchObject({ audience: InboundAudience.every_group, groups: [] });
    expect(listedTo('3')).toEqual([]);
    expect(audienceOf('3')).toBe(InboundAudience.every_group);
    expect(asked).toEqual([]);
  });

  it('lists only a member of this panel, and only an inbound a buyer can be placed on', async () => {
    const { service } = harness();
    await expect(service.setAudience(owner, PANEL, '1', { audience: InboundAudience.listed, groups: ['ffffffff-ffff-4fff-8fff-ffffffffffff'] })).rejects.toMatchObject({ reason: 'member_not_found' });
    await expect(service.setAudience(owner, PANEL, '9', { audience: InboundAudience.every_group })).rejects.toMatchObject({ reason: 'inbound_not_found' });
    await expect(service.setAudience(owner, PANEL, '5', { audience: InboundAudience.listed, groups: [GROUP] })).rejects.toMatchObject({ reason: 'inbound_not_sellable' });
    await expect(service.setAudience(owner, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '1', { audience: InboundAudience.every_group })).rejects.toMatchObject({ reason: 'panel_not_found' });
  });
});

/**
 * The holder reaches the page (F-027-ci). The envelope passes a refusal's
 * `facts` and nothing else beside it, and a fact is never free text — so the
 * holder travels as its id, and the page names it from its own scoped lists.
 */
describe('MemberInboundsService.setShare — a group\'s share of a listed inbound (F-027-eq)', () => {
  it('sets the listing\'s maxClients under the panel\'s lock, keeps it on a re-save of the listings, and null clears it', async () => {
    const { service, listings, locks } = harness();
    await service.assign(owner, OTHER_GROUP, PANEL, ['3']);
    expect(await service.setShare(owner, OTHER_GROUP, PANEL, '3', 40)).toEqual({ groupId: OTHER_GROUP, panelId: PANEL, remoteId: '3', maxClients: 40 });
    expect(locks.at(-1)).toBe(`panel_inbound:${PANEL}`);

    await service.assign(owner, OTHER_GROUP, PANEL, ['3']);
    expect(listings.find((l) => l.groupId === OTHER_GROUP && l.inboundRemoteId === '3')?.maxClients).toBe(40);

    await service.setShare(owner, OTHER_GROUP, PANEL, '3', null);
    expect(listings.find((l) => l.groupId === OTHER_GROUP && l.inboundRemoteId === '3')?.maxClients).toBeNull();
  });

  it('takes a share only on a listing: an every-group inbound, or one listed to another group, is listing_not_found', async () => {
    const { service } = harness();
    await expect(service.setShare(owner, GROUP, PANEL, '1', 5)).rejects.toMatchObject({ reason: 'listing_not_found' });
    await expect(service.setShare(owner, GROUP, PANEL, '3', 5)).rejects.toMatchObject({ reason: 'listing_not_found' });
    await expect(service.setShare({ adminId: ADMIN, tenantId: RESELLER }, OTHER_GROUP, PANEL, '3', 5)).rejects.toBeInstanceOf(PanelScopeRefused);
  });
});

describe('a refusal naming its holder, as the client receives it', () => {
  const answered = async (e: Error) => sanitizeError(await refusing(() => Promise.reject(e)).catch((x: unknown) => x));

  it('an inbound under live configs carries the inbound, the group losing it and their count', async () => {
    const out = await answered(new InboundHeldElsewhere('1', { id: OTHER_GROUP, name: 'Gaming' }, 4));
    expect(out).toMatchObject({ status: 409, reason: 'inbound_has_configs', facts: { remoteId: '1', groupId: OTHER_GROUP, configs: 4 } });
  });

  it('an address already registered carries the panel holding it, when the reader may see it', async () => {
    expect(await answered(new PanelAlreadyRegistered({ id: PANEL, name: 'Frankfurt 1' }))).toMatchObject({
      status: 409,
      reason: 'panel_already_registered',
      facts: { panelId: PANEL },
    });
    expect((await answered(new PanelAlreadyRegistered(null))).facts).toBeUndefined();
  });
});

describe('sellingInbounds', () => {
  const everyGroup = [{ remoteId: '1', protocol: ConfigProtocol.vless, maxClients: null }];
  const listed = (remoteId: string, extra: Row = {}) => ({ inbound: { remoteId, protocol: ConfigProtocol.trojan, maxClients: 5, enabled: true, goneAt: null, ...extra } });

  it('sells the every-group inbounds while the membership lists none', () => {
    expect(sellingInbounds({ inbounds: [], panel: { inbounds: everyGroup } })).toEqual([{ ...everyGroup[0], share: null }]);
  });

  it('sells its listed inbounds plus the every-group ones — not a disabled, gone or unsold-protocol listing', () => {
    const member = {
      inbounds: [listed('7'), listed('8', { enabled: false }), listed('9', { goneAt: new Date() }), listed('6', { protocol: null })],
      panel: { inbounds: everyGroup },
    };
    expect(sellingInbounds(member)).toEqual([{ remoteId: '7', protocol: ConfigProtocol.trojan, maxClients: 5, share: null }, { ...everyGroup[0], share: null }]);
  });

  it('names an inbound once, its listing first, should it come back both ways', () => {
    expect(sellingInbounds({ inbounds: [listed('1')], panel: { inbounds: everyGroup } })).toEqual([{ remoteId: '1', protocol: ConfigProtocol.trojan, maxClients: 5, share: null }]);
  });

  it('carries a listing\'s share beside the inbound\'s own cap; an every-group inbound has none (F-027-eq)', () => {
    expect(sellingInbounds({ inbounds: [{ ...listed('7'), maxClients: 2 }], panel: { inbounds: everyGroup } })).toEqual([
      { remoteId: '7', protocol: ConfigProtocol.trojan, maxClients: 5, share: 2 },
      { ...everyGroup[0], share: null },
    ]);
  });
});

describe('setInboundAudienceSchema', () => {
  it('takes every group, or the groups listed — each once — and nothing else', () => {
    expect(setInboundAudienceSchema.safeParse({ audience: 'every_group' }).success).toBe(true);
    expect(setInboundAudienceSchema.safeParse({ audience: 'listed', groups: [GROUP, OTHER_GROUP] }).success).toBe(true);
    expect(setInboundAudienceSchema.safeParse({ audience: 'listed', groups: [] }).success).toBe(true);
    expect(setInboundAudienceSchema.safeParse({ audience: 'listed', groups: [GROUP, GROUP] }).success).toBe(false);
    expect(setInboundAudienceSchema.safeParse({ audience: 'every_group', groups: [GROUP] }).success).toBe(false);
    expect(setInboundAudienceSchema.safeParse({ audience: 'listed' }).success).toBe(false);
    expect(setInboundAudienceSchema.safeParse({ audience: 'listed', groups: ['not-a-uuid'] }).success).toBe(false);
  });
});

describe('setListingShareSchema', () => {
  it('takes a cap of at least one, or null for none, and nothing else', () => {
    expect(setListingShareSchema.safeParse({ maxClients: 40 }).success).toBe(true);
    expect(setListingShareSchema.safeParse({ maxClients: null }).success).toBe(true);
    expect(setListingShareSchema.safeParse({ maxClients: 0 }).success).toBe(false);
    expect(setListingShareSchema.safeParse({}).success).toBe(false);
    expect(setListingShareSchema.safeParse({ maxClients: 4, sold: true }).success).toBe(false);
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
