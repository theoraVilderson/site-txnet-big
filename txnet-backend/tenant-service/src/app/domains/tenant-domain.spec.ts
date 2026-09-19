import { UnscopedRedisKeys } from '@txnet-backend/shared-core';

import { ResellerAccess } from '../request/reseller-access';
import { verifyRecordName } from './domain-check';
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
  const staff = { userId: STAFF, tenantId: PLATFORM, permissions: ['tenant.manage'] };
  const stranger = { userId: STAFF, tenantId: PLATFORM, permissions: [] as string[] };

  type Row = Record<string, unknown> & { id: string; tenantId: string; domainValue: string };

  const build = (opts: { rows?: Row[]; redisFails?: boolean } = {}) => {
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
    const withTenant = (row: Row) => ({ ...row, tenant: { slug: tenants[row.tenantId]?.['slug'] } });
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
      tenantDomain: domains,
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
        const snapshot = rows.map((r) => ({ ...r }));
        try {
          return await fn(all);
        } catch (e) {
          rows.splice(0, rows.length, ...snapshot);
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
    };
    const config = { get: vi.fn((k: string) => env[k]) };

    // The world outside: what DNS answers and how the platform is reached.
    const world = {
      txt: {} as Record<string, string[]>,
      cname: {} as Record<string, string[]>,
      arrivesAs: {} as Record<string, string | number>,
    };
    const lookup: DomainLookup = {
      txt: vi.fn(async (name: string) => world.txt[name] ?? []),
      cname: vi.fn(async (host: string) => world.cname[host] ?? []),
      probe: vi.fn(async (url: string): Promise<ProbeAnswer> => {
        const u = new URL(url);
        const as = world.arrivesAs[`${u.protocol}//${u.hostname}`];
        if (as === undefined) return { error: 'ECONNREFUSED' };
        if (typeof as === 'number') return { status: as, body: null };
        return { status: 200, body: { ok: true, data: { host: as, nonce: u.searchParams.get('n') } } };
      }),
    };
    const service = new TenantDomainService(new ResellerAccess(appPrisma as never), all as never, redis as never, config as never, lookup);
    return { service, rows, writes, world, all, lookup };
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

  describe('verifying', () => {
    it('moves pending to verifying on request, and the sweep verifies it and retracts the host entry', async () => {
      const { service, rows, writes, world } = build({ rows: [pendingRow()] });
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
      expect(view.lastCheck!.lines.filter((l) => l.ok).map((l) => l.check)).toEqual(['cname', 'http', 'https']);
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
      const { service, rows, writes, world } = build({ rows: [verified()] });

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
