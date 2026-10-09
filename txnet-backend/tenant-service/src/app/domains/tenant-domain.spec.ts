import { OutboxEventType, RequestHeaders, ResellerLimitReached, ResellerAccess, UnscopedRedisKeys } from '@txnet-backend/shared-core';

import { DomainCheck, verifyRecordName } from './domain-check';
import { edgeColumns, UnconfiguredEdgeProvider } from './edge/edge-provider';
import { FakeEdgeProvider } from './edge/fake-edge-provider';
import type { DomainLookup, ProbeAnswer } from './domain-lookup';
import { addDomainSchema } from './tenant-domain.schema';
import { TenantDomainService } from './tenant-domain.service';

/**
 * The invariants F-018-i turns on (catalog 13.2 steps 1-3 and 6, ADR-0060).
 *
 * - A custom domain routes only once it is `verified` (tenant invariant 5),
 *   and it becomes `verified` only when its TXT record holds its token, its
 *   CNAME names no other reseller's target, and an http **and** an https
 *   request reach the platform through it, arriving as the domain or the
 *   reseller's own `<slug>.edge.<domain>`.
 * - A failed check says what it expected and what it found, line by line.
 * - A verified domain whose record goes missing keeps routing through the
 *   grace, then drops to `pending` — and a change of what routes deletes the
 *   host's `tenant:host:*` entry in the same transaction.
 * - Only the reseller's owner, or the platform owner's staff, reaches a
 *   reseller's domains; a proven domain is never taken from its tenant.
 */
describe('TenantDomainService', () => {
  const PLATFORM = '11111111-1111-1111-1111-111111111111';
  const RESELLER = '22222222-2222-2222-2222-222222222222';
  const OTHER = '33333333-3333-3333-3333-333333333333';
  const OWNER = '44444444-4444-4444-4444-444444444444';
  const STAFF = '55555555-5555-5555-5555-555555555555';
  const HOUR = 3_600_000;
  const T0 = new Date('2026-09-18T10:00:00Z');
  const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

  const owner = { userId: OWNER, tenantId: PLATFORM, permissions: [] as string[] };
  const staff = { userId: STAFF, tenantId: PLATFORM, permissions: ['platform.tenant.manage'] };
  const stranger = { userId: STAFF, tenantId: PLATFORM, permissions: [] as string[] };

  type Row = Record<string, unknown> & { id: string; tenantId: string; domainValue: string };

  const build = (opts: { rows?: Row[]; redisFails?: boolean; domainLimit?: number | null; edgeOff?: boolean; unconfigured?: boolean } = {}) => {
    const rows: Row[] = [...(opts.rows ?? [])];
    const tenants: Record<string, Record<string, unknown>> = {
      [PLATFORM]: { id: PLATFORM, tenantType: 'platform_owner', slug: 'platform_owner', ownerUserId: STAFF, status: 'active', deletedAt: null },
      [RESELLER]: { id: RESELLER, tenantType: 'reseller', slug: 'ali', ownerUserId: OWNER, status: 'active', deletedAt: null },
      [OTHER]: { id: OTHER, tenantType: 'reseller', slug: 'reza', ownerUserId: STAFF, status: 'active', deletedAt: null },
    };
    const writes: string[] = [];
    const matches = (row: Row, where: Record<string, unknown>): boolean =>
      Object.entries(where).every(([k, v]) => {
        if (k === 'OR') return (v as Record<string, unknown>[]).some((w) => matches(row, w));
        if (v && typeof v === 'object' && !(v instanceof Date)) {
          const cond = v as { lte?: Date; in?: unknown[]; not?: unknown };
          if ('not' in cond) return (row[k] ?? null) !== cond.not;
          if (cond.lte) return row[k] instanceof Date && (row[k] as Date) <= cond.lte;
          if (cond.in) return cond.in.includes(row[k]);
        }
        return (row[k] ?? null) === v;
      });
    const withTenant = (row: Row) => ({ ...row, tenant: { slug: tenants[row.tenantId]?.['slug'], ownerUserId: tenants[row.tenantId]?.['ownerUserId'] } });
    // Outbox rows, written inside the transaction: a rollback takes them with it.
    const outbox: { type: string; aggregateId: string; payload: Record<string, unknown> }[] = [];
    const domains = {
      findUnique: vi.fn(async ({ where }: { where: { domainValue: string } }) => {
        const row = rows.find((r) => r.domainValue === where.domainValue);
        return row ? withTenant(row) : null;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = rows.find((r) => matches(r, where));
        return row ? withTenant(row) : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)).map(withTenant)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `d${rows.length + 1}`, verifiedAt: null, lastCheck: null, lastCheckedAt: null, revalidatingSince: null, ...data } as unknown as Row;
        rows.push(row);
        writes.push(`create ${row.domainValue}`);
        return withTenant(row);
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const i = rows.findIndex((r) => r.id === where.id);
        writes.push(`delete ${rows[i].domainValue}`);
        return rows.splice(i, 1)[0];
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return withTenant(row);
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        if (hit.length) writes.push(`update ${hit[0].domainValue} ${String(hit[0]['verificationStatus'])}`);
        return { count: hit.length };
      }),
    };
    const appPrisma = {
      tenant: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null),
      },
    };
    // Rolls back on a throw, as Postgres does: the cache delete runs inside the transaction.
    const all = {
      tenantDomain: { ...domains, count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)).length) },
      // ADR-0106's levels, the platform's alone here (F-019-q).
      tenant: {
        findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
        findFirst: async ({ where }: { where: { tenantType: string } }) => Object.values(tenants).find((t) => t['tenantType'] === where.tenantType) ?? null,
      },
      outboxEvent: {
        create: vi.fn(async ({ data }: { data: { type: string; aggregateId: string; payload: Record<string, unknown> } }) => {
          outbox.push(data);
          return data;
        }),
      },
      tenantSubscription: { findUnique: async () => null },
      // A bought reseller's owner is a user of the platform's tenant (F-019-h).
      user: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === OWNER ? { tenantId: PLATFORM } : null) },
      resellerLimit: { findMany: async () => [] },
      packageLimit: { findMany: async () => [] },
      resellerLimitSetting: {
        findMany: async () => (opts.domainLimit === undefined ? [] : [{ key: 'custom_domains_max', value: opts.domainLimit }]),
      },
      $executeRaw: vi.fn(async () => 1),
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
        const snapshot = rows.map((r) => ({ ...r }));
        const told = outbox.length;
        try {
          return await fn(all);
        } catch (e) {
          rows.splice(0, rows.length, ...snapshot);
          outbox.splice(told);
          throw e;
        }
      }),
    };
    const redis = {
      del: vi.fn(async (key: string) => {
        if (opts.redisFails) throw new Error('redis down');
        writes.push(`del ${key}`);
      }),
    };
    const env: Record<string, unknown> = {
      DOMAIN_NAME: 'txnet.app',
      DOMAIN_VERIFY_WINDOW_HOURS: 72,
      DOMAIN_REVALIDATE_EVERY_HOURS: 6,
      DOMAIN_REVALIDATION_GRACE_HOURS: 72,
      EDGE_LIFECYCLE_ENABLED: opts.edgeOff ? 'false' : 'true',
    };
    const config = { get: vi.fn((k: string) => env[k]) };

    // The world outside: what DNS answers and how the platform is reached.
    const world = {
      txt: {} as Record<string, string[]>,
      cname: {} as Record<string, string[]>,
      arrivesAs: {} as Record<string, string | number>,
      /** A CDN that caches the probe by URL alone, whatever the request carried. */
      cachesEverything: false,
    };
    const cached = new Map<string, ProbeAnswer>();
    const lookup: DomainLookup = {
      txt: vi.fn(async (name: string) => world.txt[name] ?? []),
      cname: vi.fn(async (host: string) => world.cname[host] ?? []),
      probe: vi.fn(async (url: string, headers: Record<string, string> = {}): Promise<ProbeAnswer> => {
        const u = new URL(url);
        if (world.cachesEverything && cached.has(url)) return cached.get(url)!;
        const as = world.arrivesAs[`${u.protocol}//${u.hostname}`];
        if (as === undefined) return { error: 'ECONNREFUSED' };
        if (typeof as === 'number') return { status: as, body: null };
        const nonce = u.searchParams.get('n') ?? headers[RequestHeaders.domainProbe] ?? null;
        const answer = { status: 200, body: { ok: true, data: { host: as, nonce } } };
        cached.set(url, answer);
        return answer;
      }),
    };
    const edge = new FakeEdgeProvider();
    const provider = opts.unconfigured ? new UnconfiguredEdgeProvider() : edge;
    const service = new TenantDomainService(new ResellerAccess(appPrisma as never), all as never, redis as never, config as never, lookup, provider);
    return { service, rows, writes, world, all, lookup, edge, outbox };
  };

  const pendingRow = (over: Partial<Row> = {}): Row => ({
    id: 'd1',
    tenantId: RESELLER,
    domainType: 'custom_domain',
    domainValue: 'ali-vpn.ir',
    purpose: 'panel',
    verificationStatus: 'pending',
    verificationToken: 'tok-1',
    statusChangedAt: T0,
    verifiedAt: null,
    lastCheckedAt: null,
    lastCheck: null,
    lastRevalidatedAt: null,
    revalidatingSince: null,
    edgeProvider: null,
    edgeHostnameId: null,
    edgeStatus: 'none',
    edgeCheckedAt: null,
    edgeLastError: null,
    edgeOwnershipName: null,
    edgeOwnershipValue: null,
    ownershipProvenAt: null,
    ...over,
  });

  const healthy = (world: ReturnType<typeof build>['world']) => {
    world.txt[verifyRecordName('ali-vpn.ir')] = ['tok-1'];
    world.cname['ali-vpn.ir'] = ['ali.edge.txnet.app'];
    world.arrivesAs['http://ali-vpn.ir'] = 'ali-vpn.ir';
    world.arrivesAs['https://ali-vpn.ir'] = 'ali-vpn.ir';
  };

  describe('adding', () => {
    it('normalizes the host and refuses the platform own zone at the schema', () => {
      expect(addDomainSchema.parse({ domainValue: ' Ali-VPN.ir. ' }).domainValue).toBe('ali-vpn.ir');
      expect(addDomainSchema.safeParse({ domainValue: 'localhost' }).success).toBe(false);
      expect(addDomainSchema.safeParse({ domainValue: 'ali-vpn.ir:443' }).success).toBe(false);
    });

    it('creates a pending row with a fresh token and names the TXT record and the CNAME target', async () => {
      const { service, rows, writes } = build();
      const view = await service.add(owner, RESELLER, { domainValue: 'ali-vpn.ir', purpose: 'panel' }, T0);

      expect(view.status).toBe('pending');
      expect(view.record).toEqual({ type: 'TXT', name: verifyRecordName('ali-vpn.ir'), value: rows[0]['verificationToken'] });
      expect(String(rows[0]['verificationToken'])).toMatch(/^[0-9a-f]{32}$/);
      expect(view.cnameTarget).toBe('ali.edge.txnet.app');
      expect(writes).toEqual(['create ali-vpn.ir', `del ${UnscopedRedisKeys.tenantByHost('ali-vpn.ir')}`]);
    });

    it('refuses a host inside the platform domain', async () => {
      const { service } = build();
      await expect(service.add(owner, RESELLER, { domainValue: 'x.txnet.app', purpose: 'panel' }, T0)).rejects.toMatchObject({
        reason: 'domain_reserved',
      });
    });

    it('never takes a proven domain from its tenant, but replaces another tenant unproven claim', async () => {
      const proven = build({ rows: [pendingRow({ tenantId: OTHER, verificationStatus: 'verified' })] });
      await expect(proven.service.add(owner, RESELLER, { domainValue: 'ali-vpn.ir', purpose: 'panel' }, T0)).rejects.toMatchObject({
        reason: 'domain_taken',
      });

      const squatted = build({ rows: [pendingRow({ tenantId: OTHER, verificationStatus: 'verifying' })] });
      await squatted.service.add(owner, RESELLER, { domainValue: 'ali-vpn.ir', purpose: 'panel' }, T0);
      expect(squatted.rows).toHaveLength(1);
      expect(squatted.rows[0].tenantId).toBe(RESELLER);
      expect(squatted.rows[0]['verificationToken']).not.toBe('tok-1');
      expect(squatted.writes.slice(0, 2)).toEqual(['delete ali-vpn.ir', 'create ali-vpn.ir']);
    });

    it('lets the platform owner staff in, and refuses anyone else without saying whether the reseller exists', async () => {
      const { service, all } = build();
      await expect(service.add(staff, RESELLER, { domainValue: 'ali-vpn.ir', purpose: 'panel' }, T0)).resolves.toMatchObject({
        status: 'pending',
      });
      await expect(service.list(stranger, RESELLER)).rejects.toMatchObject({ reason: 'not_allowed' });
      await expect(service.list(stranger, '99999999-9999-9999-9999-999999999999')).rejects.toMatchObject({ reason: 'not_allowed' });
      await expect(service.list(owner, OTHER)).rejects.toMatchObject({ reason: 'not_allowed' });
      expect(all.tenantDomain.findMany).not.toHaveBeenCalled();
    });
  });

  describe('the reseller\'s limit on custom domains (F-019-q, ADR-0106)', () => {
    const two = () => [pendingRow({ id: 'd1', domainValue: 'a.ir' }), pendingRow({ id: 'd2', domainValue: 'b.ir', verificationStatus: 'verified' })];

    it('refuses the reseller\'s own people one more at the limit, writing nothing', async () => {
      const { service, rows, writes } = build({ rows: two(), domainLimit: 2 });
      const err = await service.add(owner, RESELLER, { domainValue: 'c.ir', purpose: 'panel' }, T0).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResellerLimitReached);
      expect(err).toMatchObject({ key: 'custom_domains_max', limit: 2, used: 2 });
      expect(rows).toHaveLength(2);
      expect(writes).toEqual([]);
    });

    it('lets the platform\'s staff through, counts only this reseller\'s domains, and uses the default 5 when nothing is set', async () => {
      await expect(build({ rows: two(), domainLimit: 2 }).service.add(staff, RESELLER, { domainValue: 'c.ir', purpose: 'panel' }, T0)).resolves.toMatchObject({ status: 'pending' });
      const others = [1, 2, 3, 4, 5].map((i) => pendingRow({ id: `o${i}`, tenantId: OTHER, domainValue: `o${i}.ir` }));
      await expect(build({ rows: others }).service.add(owner, RESELLER, { domainValue: 'c.ir', purpose: 'panel' }, T0)).resolves.toMatchObject({ status: 'pending' });
    });

    it('never refuses adding again a domain the reseller already has', async () => {
      const { service } = build({ rows: two(), domainLimit: 2 });
      await expect(service.add(owner, RESELLER, { domainValue: 'a.ir', purpose: 'panel' }, T0)).resolves.toMatchObject({ domainValue: 'a.ir' });
    });
  });

  describe('verifying', () => {
    it('moves pending to verifying on request, and the sweep verifies it and retracts the host entry', async () => {
      const { service, rows, writes, world } = build({ rows: [pendingRow()], edgeOff: true });
      await service.requestCheck(owner, RESELLER, 'd1', at(1));
      expect(rows[0]['verificationStatus']).toBe('verifying');

      healthy(world);
      const sweep = await service.checkDue(at(2));

      expect(sweep).toMatchObject({ due: 1, verified: 1, failed: 0 });
      expect(rows[0]).toMatchObject({ verificationStatus: 'verified', verifiedAt: at(2), lastRevalidatedAt: at(2) });
      expect(writes.slice(-2)).toEqual(['update ali-vpn.ir verified', `del ${UnscopedRedisKeys.tenantByHost('ali-vpn.ir')}`]);
      expect((rows[0]['lastCheck'] as { ok: boolean }).ok).toBe(true);
    });

    it('shows exactly what it expected and what it found, and keeps trying inside the window', async () => {
      const { service, rows, world } = build({ rows: [pendingRow({ verificationStatus: 'verifying' })] });
      healthy(world);
      world.txt[verifyRecordName('ali-vpn.ir')] = ['tok-old', 'v=spf1 -all'];

      const sweep = await service.checkDue(at(1));
      expect(sweep).toMatchObject({ waiting: 1, verified: 0 });
      expect(rows[0]['verificationStatus']).toBe('verifying');

      const [view] = await service.list(owner, RESELLER);
      const txt = view.lastCheck!.lines.find((l) => l.check === 'txt')!;
      expect(txt).toEqual({ check: 'txt', expected: [`${verifyRecordName('ali-vpn.ir')} TXT tok-1`], found: ['tok-old', 'v=spf1 -all'], ok: false });
      expect(view.lastCheck!.lines.filter((l) => l.ok).map((l) => l.check)).toEqual(['cname', 'http', 'https', 'cache']);
    });

    it('fails once the window closes', async () => {
      const { service, rows } = build({ rows: [pendingRow({ verificationStatus: 'verifying' })] });
      await service.checkDue(at(71));
      expect(rows[0]['verificationStatus']).toBe('verifying');
      const sweep = await service.checkDue(at(72));
      expect(sweep).toMatchObject({ failed: 1 });
      expect(rows[0]['verificationStatus']).toBe('failed');
    });

    it('needs both an http and an https answer from the platform', async () => {
      const { service, rows, world } = build({ rows: [pendingRow({ verificationStatus: 'verifying' })] });
      healthy(world);
      world.arrivesAs['http://ali-vpn.ir'] = 404; // a CDN page, not the platform

      await service.checkDue(at(1));
      const http = (rows[0]['lastCheck'] as { lines: { check: string; found: string[]; ok: boolean }[] }).lines.find((l) => l.check === 'http')!;
      expect(http).toMatchObject({ ok: false, found: ['404'] });
      expect(rows[0]['verificationStatus']).toBe('verifying');
    });

    it('refuses a domain pointed at another reseller target, by DNS or by the host the request arrived as', async () => {
      const byDns = build({ rows: [pendingRow({ verificationStatus: 'verifying' })] });
      healthy(byDns.world);
      byDns.world.cname['ali-vpn.ir'] = ['reza.edge.txnet.app'];
      await byDns.service.checkDue(at(1));
      expect(byDns.rows[0]['verificationStatus']).toBe('verifying');

      const byHost = build({ rows: [pendingRow({ verificationStatus: 'verifying' })] });
      healthy(byHost.world);
      byHost.world.cname['ali-vpn.ir'] = ['ali-vpn.ir.cdn.example']; // a CDN in front: DNS decides nothing
      byHost.world.arrivesAs['https://ali-vpn.ir'] = 'reza.edge.txnet.app';
      await byHost.service.checkDue(at(1));
      expect(byHost.rows[0]['verificationStatus']).toBe('verifying');

      const cdn = build({ rows: [pendingRow({ verificationStatus: 'verifying' })] });
      healthy(cdn.world);
      cdn.world.cname['ali-vpn.ir'] = ['ali-vpn.ir.cdn.example'];
      await cdn.service.checkDue(at(1));
      expect(cdn.rows[0]['verificationStatus']).toBe('verified');
    });

    it('refuses a CDN that forwards the CNAME target instead of the domain', async () => {
      // ADR-0063: the target serves nothing, so a request that arrives as it
      // would be refused on every page. Refusing here says so at setup time,
      // with the host the CDN sent, instead of to the reseller's customers.
      const { service, rows, world } = build({ rows: [pendingRow({ verificationStatus: 'verifying' })] });
      healthy(world);
      world.arrivesAs['https://ali-vpn.ir'] = 'ali.edge.txnet.app';
      await service.checkDue(at(1));
      const https = (rows[0]['lastCheck'] as { lines: { check: string; found: string[]; ok: boolean }[] }).lines.find((l) => l.check === 'https')!;
      expect(https).toMatchObject({ ok: false, found: ['200 as ali.edge.txnet.app'] });
      expect(rows[0]['verificationStatus']).toBe('verifying');
    });

    it('refuses to verify when the host entry cannot be retracted', async () => {
      const { service, rows, world } = build({ rows: [pendingRow({ verificationStatus: 'verifying' })], redisFails: true });
      healthy(world);
      const sweep = await service.checkDue(at(1));
      expect(sweep).toMatchObject({ errors: 1, verified: 0 });
      expect(rows[0]['verificationStatus']).toBe('verifying');
    });
  });

  describe('re-validation', () => {
    const verified = () => pendingRow({ verificationStatus: 'verified', verifiedAt: T0, lastCheckedAt: T0, lastRevalidatedAt: T0 });

    it('checks a verified domain only when it is due, and only its TXT record', async () => {
      const { service, world, lookup } = build({ rows: [verified()] });
      healthy(world);
      expect(await service.checkDue(at(5))).toMatchObject({ due: 0 });
      expect(await service.checkDue(at(6))).toMatchObject({ due: 1, revalidated: 1 });
      expect(lookup.probe).not.toHaveBeenCalled();
    });

    it('keeps routing a lost record through the grace, then drops it to pending and retracts the host', async () => {
      const { service, rows, writes, world } = build({ rows: [verified()], edgeOff: true });

      expect(await service.checkDue(at(6))).toMatchObject({ revalidating: 1 });
      expect(rows[0]).toMatchObject({ verificationStatus: 'verified', revalidatingSince: at(6) });
      expect((await service.list(owner, RESELLER))[0].status).toBe('revalidating');
      expect(writes.some((w) => w.startsWith('del'))).toBe(false);

      expect(await service.checkDue(at(77))).toMatchObject({ revalidating: 1 });
      expect(await service.checkDue(at(78))).toMatchObject({ dropped: 1 });
      expect(rows[0]).toMatchObject({ verificationStatus: 'pending', revalidatingSince: null, verificationToken: 'tok-1' });
      expect(writes.at(-1)).toBe(`del ${UnscopedRedisKeys.tenantByHost('ali-vpn.ir')}`);
      void world;
    });

    it('clears the grace when the record comes back', async () => {
      const { service, rows, world } = build({ rows: [verified()] });
      await service.checkDue(at(6));
      healthy(world);
      expect(await service.checkDue(at(12))).toMatchObject({ revalidated: 1 });
      expect(rows[0]).toMatchObject({ verificationStatus: 'verified', revalidatingSince: null, lastRevalidatedAt: at(12) });
    });
  });

  describe('the edge ownership record behind a reseller\'s own CDN (EDGE-1-d, ADR-0129 (4))', () => {
    const OWNER_NAME = '_cf-custom-hostname.ali-vpn.ir';
    const registered = (over: Partial<Row> = {}) =>
      pendingRow({
        verificationStatus: 'verified',
        verifiedAt: T0,
        lastCheckedAt: T0,
        lastRevalidatedAt: T0,
        edgeStatus: 'issuing',
        edgeOwnershipName: OWNER_NAME,
        edgeOwnershipValue: 'cf-v1',
        ...over,
      });

    it('stores what the provider answered, and clears the record once the provider no longer asks for it', () => {
      const asked = { id: 'ch-1', host: 'ali-vpn.ir', status: 'issuing' as const, ownership: { type: 'TXT' as const, name: OWNER_NAME, value: 'cf-v1' }, errors: ['not yet'] };
      expect(edgeColumns('cloudflare', asked, T0)).toEqual({
        edgeProvider: 'cloudflare',
        edgeHostnameId: 'ch-1',
        edgeStatus: 'issuing',
        edgeCheckedAt: T0,
        edgeLastError: 'not yet',
        edgeOwnershipName: OWNER_NAME,
        edgeOwnershipValue: 'cf-v1',
      });
      expect(edgeColumns('cloudflare', { ...asked, status: 'issued', ownership: null, errors: [] }, T0)).toMatchObject({
        edgeLastError: null,
        edgeOwnershipName: null,
        edgeOwnershipValue: null,
      });
    });

    it('returns the record with the domain, and nothing while there is none', async () => {
      const { service } = build({ rows: [registered(), pendingRow({ id: 'd2', domainValue: 'b.ir', verificationToken: 'tok-2' })] });
      const [a, b] = await service.list(owner, RESELLER);
      expect(a.edge).toEqual({ status: 'issuing', record: { type: 'TXT', name: OWNER_NAME, value: 'cf-v1' }, lastError: null });
      expect(b.edge).toEqual({ status: 'none', record: null, lastError: null });
    });

    it('reads it on re-validation and says Cloudflare answers 409 until it is there — without touching the domain\'s own proof', async () => {
      const { service, rows, world } = build({ rows: [registered()], edgeOff: true });
      healthy(world);
      world.cname['ali-vpn.ir'] = ['ali-vpn.ir.cdn.arvancdn.ir'];

      expect(await service.checkDue(at(6))).toMatchObject({ revalidated: 1 });
      const check = rows[0]['lastCheck'] as DomainCheck;
      expect(check.ok).toBe(true);
      expect(check.lines.find((l) => l.check === 'edge_owner')).toMatchObject({ ok: false, found: [] });
      expect(check.lines.find((l) => l.check === 'edge_owner')?.expected[0]).toContain(`${OWNER_NAME} TXT cf-v1`);
      expect(check.lines.find((l) => l.check === 'edge_owner')?.expected[0]).toContain('409');

      world.txt[OWNER_NAME] = ['cf-v1'];
      await service.checkDue(at(12));
      expect((rows[0]['lastCheck'] as DomainCheck).lines.find((l) => l.check === 'edge_owner')).toMatchObject({ ok: true, found: ['cf-v1'] });
    });

    it('needs no TXT when the CNAME goes straight to the target: the provider proves ownership by it', async () => {
      const { service, rows, world } = build({ rows: [registered()], edgeOff: true });
      healthy(world);
      await service.checkDue(at(6));
      expect((rows[0]['lastCheck'] as DomainCheck).lines.find((l) => l.check === 'edge_owner')).toMatchObject({ ok: true });
    });

    it('verifies a domain whose ownership record is missing: the record is the edge\'s, not the domain\'s proof', async () => {
      const { service, rows, world } = build({ rows: [registered({ verificationStatus: 'verifying', verifiedAt: null })], edgeOff: true });
      healthy(world);
      world.cname['ali-vpn.ir'] = ['ali-vpn.ir.cdn.arvancdn.ir'];
      expect(await service.checkDue(at(1))).toMatchObject({ verified: 1 });
      expect((rows[0]['lastCheck'] as DomainCheck).lines.map((l) => l.check)).toEqual(['txt', 'cname', 'http', 'https', 'cache', 'edge_owner']);
    });

    it('adds no line for a domain with no record', async () => {
      const { service, rows, world } = build({ rows: [registered({ edgeOwnershipName: null, edgeOwnershipValue: null })], edgeOff: true });
      healthy(world);
      await service.checkDue(at(6));
      expect((rows[0]['lastCheck'] as DomainCheck).lines.map((l) => l.check)).toEqual(['txt']);
    });
  });

  describe('a signed-in page served from a CDN cache (ADR-0129 (8))', () => {
    it('fails a domain whose CDN answers the second request with the first one\'s page', async () => {
      const { service, rows, world } = build({ rows: [pendingRow({ verificationStatus: 'verifying' })] });
      healthy(world);
      world.cachesEverything = true;

      expect(await service.checkDue(at(1))).toMatchObject({ waiting: 1, verified: 0 });
      const cache = (rows[0]['lastCheck'] as DomainCheck).lines.find((l) => l.check === 'cache')!;
      expect(cache).toMatchObject({ ok: false, found: ['cached'] });
      expect(cache.expected[0]).toContain('private, no-store');
    });

    it('passes a CDN that keeps each request its own', async () => {
      const { service, rows, world } = build({ rows: [pendingRow({ verificationStatus: 'verifying' })] });
      healthy(world);
      await service.checkDue(at(1));
      expect((rows[0]['lastCheck'] as DomainCheck).lines.find((l) => l.check === 'cache')).toMatchObject({ ok: true });
    });
  });

  describe('the edge lifecycle (EDGE-1-e, ADR-0129 (6))', () => {
    const verified = (over: Partial<Row> = {}) =>
      pendingRow({ verificationStatus: 'verified', verifiedAt: T0, lastCheckedAt: at(1), lastRevalidatedAt: at(1), ...over });

    it('registers a domain the tick it is verified, and stores the step and the ownership record', async () => {
      const { service, rows, world, edge } = build({ rows: [pendingRow({ verificationStatus: 'verifying' })] });
      healthy(world);

      const sweep = await service.checkDue(at(1));

      expect(sweep).toMatchObject({ verified: 1, edgeRegistered: 1 });
      expect(rows[0]).toMatchObject({ edgeProvider: 'cloudflare', edgeHostnameId: 'fake-1', edgeStatus: 'issuing', edgeCheckedAt: at(1) });
      expect(rows[0]['edgeOwnershipName']).toBe('_cf-custom-hostname.ali-vpn.ir');
      expect([...edge.hostnames.values()].map((h) => h.host)).toEqual(['ali-vpn.ir']);
    });

    it('reads the status every tick until issued, then only when re-validation is due', async () => {
      const { service, rows, edge } = build({ rows: [verified()] });
      await service.checkDue(at(2));
      expect(rows[0]['edgeStatus']).toBe('issuing');

      edge.set('fake-1', { status: 'issued', ownership: null });
      expect(await service.checkDue(at(3))).toMatchObject({ edgeIssued: 1 });
      expect(rows[0]).toMatchObject({ edgeStatus: 'issued', edgeOwnershipName: null, edgeLastError: null });

      const status = vi.spyOn(edge, 'status');
      await service.checkDue(at(4));
      expect(status).not.toHaveBeenCalled();
      edge.set('fake-1', { status: 'renew_failed' });
      await service.checkDue(at(9));
      expect(rows[0]['edgeStatus']).toBe('renew_failed');
    });

    it('a failure keeps what the provider said was wrong, and a check the tenant asks for starts it over', async () => {
      const { service, rows, edge } = build({ rows: [verified()] });
      await service.checkDue(at(2));
      edge.set('fake-1', { status: 'failed', errors: ['custom hostname validation timed out'] });

      expect(await service.checkDue(at(3))).toMatchObject({ edgeFailed: 1 });
      expect(rows[0]).toMatchObject({ edgeStatus: 'failed', edgeLastError: 'custom hostname validation timed out' });
      expect((await service.list(owner, RESELLER))[0].edge).toMatchObject({ status: 'failed', lastError: 'custom hostname validation timed out' });

      await service.requestCheck(owner, RESELLER, 'd1', at(4));
      expect(rows[0]['edgeStatus']).toBe('none');
      expect(await service.checkDue(at(5))).toMatchObject({ edgeRegistered: 1 });
      expect(rows[0]).toMatchObject({ edgeStatus: 'issuing', edgeHostnameId: 'fake-2' });
      expect(edge.hostnames.has('fake-1')).toBe(false);
    });

    it('registers again a hostname the provider no longer has: our table is the list', async () => {
      const { service, rows, edge } = build({ rows: [verified()] });
      await service.checkDue(at(2));
      await edge.remove('fake-1');
      await service.checkDue(at(3));
      await service.checkDue(at(4));
      expect(rows[0]).toMatchObject({ edgeStatus: 'issuing', edgeHostnameId: 'fake-2' });
    });

    it('takes a domain that is no longer verified off the CDN', async () => {
      const { service, rows, edge } = build({ rows: [verified({ lastCheckedAt: T0, lastRevalidatedAt: T0 })] });
      await service.checkDue(at(1));
      expect(edge.hostnames.size).toBe(1);

      // The record is lost; past the grace the domain drops to pending.
      await service.checkDue(at(7));
      const sweep = await service.checkDue(at(80));

      expect(sweep).toMatchObject({ dropped: 1, edgeRemoved: 1 });
      expect(edge.hostnames.size).toBe(0);
      expect(rows[0]).toMatchObject({ edgeStatus: 'none', edgeHostnameId: null, edgeProvider: null, edgeOwnershipName: null });
    });

    it('a provider that refuses is a sweep error with its reason kept, and the next tick tries again', async () => {
      const { service, rows } = build({ rows: [verified()], unconfigured: true });
      expect(await service.checkDue(at(2))).toMatchObject({ errors: 1, edgeRegistered: 0 });
      expect(rows[0]).toMatchObject({ edgeStatus: 'registering', edgeLastError: 'no edge provider configured' });
    });

    it('touches no edge while the lifecycle is off (EDGE-1-i turns it on)', async () => {
      const { service, rows, edge } = build({ rows: [verified()], edgeOff: true });
      await service.checkDue(at(2));
      expect(edge.hostnames.size).toBe(0);
      expect(rows[0]['edgeStatus']).toBe('none');
    });
  });

  describe('two stages: proven ownership puts the domain at the edge (EDGE-1-n, ADR-0129 amendment 3)', () => {
    /** TXT and CNAME in place, but the edge answers 409 and has no certificate: it does not hold the host yet. */
    const atTheEdgeOnly = (world: ReturnType<typeof build>['world']) => {
      world.txt[verifyRecordName('ali-vpn.ir')] = ['tok-1'];
      world.cname['ali-vpn.ir'] = ['ali.edge.txnet.app'];
      world.arrivesAs['http://ali-vpn.ir'] = 409;
    };

    it('registers a verifying domain once TXT and CNAME pass, and verifies it when the probes come through', async () => {
      const { service, rows, world, edge } = build({ rows: [pendingRow({ verificationStatus: 'verifying' })] });
      atTheEdgeOnly(world);

      expect(await service.checkDue(at(1))).toMatchObject({ waiting: 1, verified: 0, edgeRegistered: 1 });
      expect(rows[0]).toMatchObject({ verificationStatus: 'verifying', ownershipProvenAt: at(1), edgeStatus: 'issuing', edgeHostnameId: 'fake-1' });

      // The certificate is issued and the edge forwards the host: the probe lines pass.
      edge.set('fake-1', { status: 'issued', ownership: null });
      healthy(world);
      expect(await service.checkDue(at(2))).toMatchObject({ verified: 1, edgeIssued: 1 });
      expect(rows[0]).toMatchObject({ verificationStatus: 'verified', edgeStatus: 'issued', edgeHostnameId: 'fake-1' });
      expect(edge.hostnames.size).toBe(1);
    });

    it('proves nothing and registers nothing while the TXT record is missing', async () => {
      const { service, rows, world, edge } = build({ rows: [pendingRow({ verificationStatus: 'verifying' })] });
      atTheEdgeOnly(world);
      world.txt[verifyRecordName('ali-vpn.ir')] = [];

      expect(await service.checkDue(at(1))).toMatchObject({ waiting: 1, edgeRegistered: 0 });
      expect(rows[0]).toMatchObject({ ownershipProvenAt: null, edgeStatus: 'none' });
      expect(edge.hostnames.size).toBe(0);
    });

    it('a proven domain that never verifies fails at the window, loses its proof and leaves the edge', async () => {
      const { service, rows, world, edge } = build({ rows: [pendingRow({ verificationStatus: 'verifying' })] });
      atTheEdgeOnly(world);
      await service.checkDue(at(1));
      expect(edge.hostnames.size).toBe(1);

      expect(await service.checkDue(at(72))).toMatchObject({ failed: 1, edgeRemoved: 1 });
      expect(rows[0]).toMatchObject({ verificationStatus: 'failed', ownershipProvenAt: null, edgeStatus: 'none', edgeHostnameId: null });
      expect(edge.hostnames.size).toBe(0);
    });

    it('holds no domain at the edge while the lifecycle is off', async () => {
      const { service, rows, world, edge } = build({ rows: [pendingRow({ verificationStatus: 'verifying' })], edgeOff: true });
      atTheEdgeOnly(world);
      await service.checkDue(at(1));
      expect(rows[0]['ownershipProvenAt']).toEqual(at(1));
      expect(edge.hostnames.size).toBe(0);
    });
  });

  describe('every change of status or result writes tenant.domain.changed (RT-1-e, RT-1-e2, C-14)', () => {
    it('names the domain for the owner\'s channel and the platform staff\'s, in the transaction that wrote it', async () => {
      const { service, world, outbox } = build({ rows: [pendingRow()] });
      await service.requestCheck(owner, RESELLER, 'd1', at(1));
      healthy(world);
      await service.checkDue(at(2));

      expect(outbox.map((e) => e.type)).toEqual(Array(4).fill(OutboxEventType.TENANT_DOMAIN_CHANGED));
      expect(outbox[0]).toMatchObject({ aggregateId: 'd1', payload: { domainId: 'd1', resellerId: RESELLER, userId: OWNER, tenantId: PLATFORM } });
    });

    it('tells the page a new check result, and nothing for the same result again (RT-1-e2)', async () => {
      const { service, world, outbox } = build({ rows: [pendingRow({ verificationStatus: 'verifying' })] });
      await service.checkDue(at(1));
      expect(outbox.map((e) => e.type)).toEqual([OutboxEventType.TENANT_DOMAIN_CHANGED]);
      await service.checkDue(at(2));
      expect(outbox).toHaveLength(1);

      world.cname['ali-vpn.ir'] = ['ali.edge.txnet.app'];
      await service.checkDue(at(3));
      expect(outbox).toHaveLength(2);
    });

    it('tells the owner once the domain is live, by whichever of the check and the certificate lands second (RT-1-e2)', async () => {
      const { service, rows, world, edge, outbox } = build({ rows: [pendingRow({ verificationStatus: 'verifying' })] });
      world.txt[verifyRecordName('ali-vpn.ir')] = ['tok-1'];
      world.cname['ali-vpn.ir'] = ['ali.edge.txnet.app'];
      world.arrivesAs['http://ali-vpn.ir'] = 409;
      await service.checkDue(at(1));
      edge.set('fake-1', { status: 'issued', ownership: null });
      healthy(world);
      await service.checkDue(at(2));
      expect(rows[0]).toMatchObject({ verificationStatus: 'verified', edgeStatus: 'issued' });

      const told = outbox.filter((e) => e.type === OutboxEventType.TENANT_DOMAIN_NOTICE);
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ aggregateId: 'd1', payload: { tenantId: RESELLER, ownerUserId: OWNER, ownerTenantId: PLATFORM, host: 'ali-vpn.ir', outcome: 'live' } });

      await service.checkDue(at(9));
      expect(outbox.filter((e) => e.type === OutboxEventType.TENANT_DOMAIN_NOTICE)).toHaveLength(1);
    });

    it('tells the owner a domain that failed its window, and one that lost its record (RT-1-e2)', async () => {
      const failing = build({ rows: [pendingRow({ verificationStatus: 'verifying' })], edgeOff: true });
      await failing.service.checkDue(at(72));
      expect(failing.outbox.filter((e) => e.type === OutboxEventType.TENANT_DOMAIN_NOTICE).map((e) => e.payload['outcome'])).toEqual(['failed']);

      const losing = build({
        rows: [pendingRow({ verificationStatus: 'verified', verifiedAt: T0, lastCheckedAt: T0, revalidatingSince: at(1) })],
        edgeOff: true,
      });
      await losing.service.checkDue(at(80));
      expect(losing.outbox.filter((e) => e.type === OutboxEventType.TENANT_DOMAIN_NOTICE).map((e) => e.payload['outcome'])).toEqual(['dropped']);
    });

    it('a write that rolls back takes its event with it', async () => {
      const { service, world, outbox } = build({ rows: [pendingRow({ verificationStatus: 'verifying' })], redisFails: true });
      healthy(world);
      await service.checkDue(at(1));
      expect(outbox).toEqual([]);
    });
  });

  describe('the probe', () => {
    it('answers only on a host the platform has a row for, echoing the nonce', async () => {
      const { service } = build({ rows: [pendingRow()] });
      await expect(service.probeAnswer('Ali-VPN.ir:443', 'abcdef0123456789')).resolves.toEqual({
        host: 'ali-vpn.ir',
        nonce: 'abcdef0123456789',
      });
      await expect(service.probeAnswer('stranger.example', 'abcdef0123456789')).resolves.toBeNull();
    });
  });
});
