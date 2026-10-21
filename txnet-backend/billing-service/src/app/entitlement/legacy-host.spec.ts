import { DomainVerificationStatus, GrantStatus, TenantDomainPurpose } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { LegacyHostService, legacyLinkUrl } from './legacy-host';
import { MigrationSeamRefused, MigrationSeamUnavailable, type SubscriptionLinkProbe } from './migration-seams';

/**
 * F-204-b (D-63): the import page's last step tests one imported user's old
 * link from outside, as their app would fetch it. What fails silently here:
 * the test fetching a host the reseller has not proved (a hostile source
 * named it, and an unproved host may still be the old panel, which would
 * answer "works" for a link we do not serve); a cancelled Grant's link picked
 * as the sample, so a working host reads broken; a path with a space or a `?`
 * sent unescaped, so the fetch reads another path; and the source's refusal
 * thrown as our error instead of shown as the test's result.
 */
const TENANT = '00000000-0000-4000-8000-0000000000aa';
const ACTOR = { userId: '00000000-0000-4000-8000-0000000000bb' } as never;
type Row = Record<string, unknown>;

function fakeDb(opts: { routed?: boolean; link?: Row | null; label?: string | null } = {}) {
  const calls: Record<string, Row[]> = { domain: [], link: [], groupBy: [] };
  const tx = {
    $executeRaw: async () => 0,
    tenantDomain: {
      findFirst: async (q: Row) => {
        calls['domain'].push(q);
        return opts.routed === false ? null : { id: 'domain-1' };
      },
    },
    legacySubLink: {
      groupBy: async (q: Row) => {
        calls['groupBy'].push(q);
        return [
          { host: 'sub.ali-vpn.ir', _count: { _all: 812 } },
          { host: 'old.ali-vpn.ir', _count: { _all: 3 } },
        ];
      },
      findFirst: async (q: Row) => {
        calls['link'].push(q);
        return opts.link === undefined ? { path: '/sub/ali reza?x', migrationItemId: 'item-1' } : opts.link;
      },
    },
    migrationItem: { findFirst: async () => (opts.label === null ? { sourceSnapshot: null } : { sourceSnapshot: { label: opts.label ?? 'ali' } }) },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  return { prisma, calls };
}

// The door runs the work in the reseller's tenant, as `ResellerAccess` does.
const access = { for: () => ({ run: (_a: unknown, tenantId: string, _c: unknown, work: () => unknown) => runWithTenant({ id: tenantId }, work) }) };

function service(db: ReturnType<typeof fakeDb>, probe: (url: string) => Promise<number>) {
  const fetched: string[] = [];
  const linkProbe = { servers: async (url: string) => (fetched.push(url), probe(url)) } as unknown as SubscriptionLinkProbe;
  return { svc: new LegacyHostService(db.prisma as never, access as never, linkProbe), fetched };
}

describe('legacyLinkUrl', () => {
  it('escapes the decoded path the way an app sends it', () => {
    expect(legacyLinkUrl('sub.ali-vpn.ir', '/sub/ali reza?x#y')).toBe('https://sub.ali-vpn.ir/sub/ali%20reza%3Fx%23y');
  });
});

describe('LegacyHostService.hosts', () => {
  it('lists the reseller’s old hosts with how many links each keeps, most first', async () => {
    const db = fakeDb();
    const { svc } = service(db, async () => 0);
    expect(await svc.hosts(ACTOR, TENANT)).toEqual({
      hosts: [
        { host: 'sub.ali-vpn.ir', links: 812 },
        { host: 'old.ali-vpn.ir', links: 3 },
      ],
    });
    expect(db.calls['groupBy'][0]).toMatchObject({ by: ['host'], where: { tenantId: TENANT } });
  });
});

describe('LegacyHostService.test', () => {
  it('fetches one live imported link on the proved host and counts its servers', async () => {
    const db = fakeDb();
    const { svc, fetched } = service(db, async () => 4);
    expect(await svc.test(ACTOR, TENANT, 'Sub.Ali-VPN.ir')).toEqual({ host: 'sub.ali-vpn.ir', label: 'ali', outcome: 'ok', servers: 4 });
    expect(fetched).toEqual(['https://sub.ali-vpn.ir/sub/ali%20reza%3Fx']);
    expect(db.calls['domain'][0]).toMatchObject({
      where: { tenantId: TENANT, domainValue: 'sub.ali-vpn.ir', purpose: TenantDomainPurpose.legacy_sub, verificationStatus: DomainVerificationStatus.verified },
    });
    expect(db.calls['link'][0]).toMatchObject({ where: { tenantId: TENANT, host: 'sub.ali-vpn.ir', grant: { status: { not: GrantStatus.cancelled } } } });
  });

  it('never fetches a host the reseller has not proved', async () => {
    const { svc, fetched } = service(fakeDb({ routed: false }), async () => 4);
    await expect(svc.test(ACTOR, TENANT, 'sub.ali-vpn.ir')).rejects.toMatchObject({ reason: 'legacy_host_not_routed' });
    expect(fetched).toEqual([]);
  });

  it('refuses a host with no live imported link to try', async () => {
    const { svc } = service(fakeDb({ link: null }), async () => 4);
    await expect(svc.test(ACTOR, TENANT, 'sub.ali-vpn.ir')).rejects.toMatchObject({ reason: 'legacy_link_not_found' });
  });

  it('answers what the fetch met as the test’s result, not as an error', async () => {
    const refused = service(fakeDb({ label: null }), async () => {
      throw new MigrationSeamRefused(502, 'source_unreadable');
    });
    expect(await refused.svc.test(ACTOR, TENANT, 'sub.ali-vpn.ir')).toEqual({ host: 'sub.ali-vpn.ir', label: null, outcome: 'failed', reason: 'source_unreadable' });

    const down = service(fakeDb(), async () => {
      throw new MigrationSeamUnavailable('network did not answer');
    });
    expect(await down.svc.test(ACTOR, TENANT, 'sub.ali-vpn.ir')).toMatchObject({ outcome: 'failed', reason: 'probe_unavailable' });
  });
});
