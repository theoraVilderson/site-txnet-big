/**
 * The platform owner sets reseller limits (F-019-m, ADR-0106): the platform's
 * value, a package's, and one or several resellers' own, each audited.
 *
 * What breaks quietly:
 *  - **anyone but the platform owner writing a limit.** Refused before anything is read;
 *  - **a value no key allows.** Past the key's bound is refused, so a typo is not a limit;
 *  - **"several" half-written.** Every named reseller is checked first; one
 *    that is not a reseller refuses the whole request and writes nothing;
 *  - **a limit nobody can account for.** One audit row per level written, with
 *    the value before and after, and the reason for a reseller's own;
 *  - **no limit confused with not set.** `null` is written as a row (no
 *    limit); clearing deletes it (the next level applies);
 *  - **a guard sold past** (F-019-v1, ADR-0107). Overage is refused on any key
 *    whose kind is not `quota`; a price is stamped with the platform's
 *    currency, and the mode is resolved apart from the number.
 */
import { ResellerAccessRefused, type ResellerAccessRejection } from '@txnet-backend/shared-core';

import { ResellerLimitsRefused, ResellerLimitsService } from './reseller-limits.service';
import { setLimitSchema, setOverageCapSchema, setOverageSchema, setResellersLimitSchema, setResellersOverageSchema, clearResellersLimitSchema } from './reseller-limits.schema';

const OWNER_TENANT = '11111111-1111-4111-8111-111111111111';
const RESELLER_A = '22222222-2222-4222-8222-222222222222';
const RESELLER_B = '33333333-3333-4333-8333-333333333333';
const PKG = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const actor = { adminId: ADMIN, tenantId: OWNER_TENANT, ip: '203.0.113.1' };

function build(
  opts: {
    callerType?: string;
    resellers?: string[];
    packages?: string[];
    usage?: { open?: number; issued?: number; domains?: number; staff?: number; sends?: number; users?: number; gib?: number };
    refuse?: ResellerAccessRejection;
  } = {},
) {
  const usage = { open: 0, issued: 0, domains: 0, staff: 0, sends: 0, users: 0, gib: 0, ...opts.usage };
  const admitted: Array<{ tenantId: string; capability: string }> = [];
  const audit: Array<Record<string, unknown>> = [];
  const writes: string[] = [];
  const setting = new Map<string, number | null>();
  const pkg = new Map<string, number | null>();
  const own = new Map<string, { value: number | null; reason: string }>();
  const resellers = new Set(opts.resellers ?? [RESELLER_A, RESELLER_B]);
  const packages = new Set(opts.packages ?? [PKG]);
  const cap: { row: { amount: unknown; currencyCode: string } | null } = { row: null };
  type Over = { key: string; mode: string; unitPrice: unknown; currencyCode: string | null };
  const overage = { platform: new Map<string, Over>(), pkg: new Map<string, Over & { packageId: string }>(), own: new Map<string, Over & { tenantId: string; reason: string }>() };
  const keyIn = (where: { key?: string | { in: string[] } }, key: string) => !where.key || (typeof where.key === 'string' ? where.key === key : where.key.in.includes(key));
  const overageTable = <T extends Over>(rows: Map<string, T>, label: string, idOf: (w: Record<string, unknown>) => string, extra: (r: T) => Record<string, unknown>) => ({
    findUnique: async ({ where }: { where: Record<string, unknown> }) => rows.get(idOf(where)) ?? null,
    findMany: async ({ where }: { where: { key?: string | { in: string[] }; tenantId?: { in: string[] } } }) =>
      [...rows.values()].filter((r) => keyIn(where, r.key) && (!where.tenantId || where.tenantId.in.includes((r as unknown as { tenantId: string }).tenantId))).map((r) => ({ ...r, ...extra(r) })),
    upsert: async ({ where, create }: { where: Record<string, unknown>; create: T }) => (writes.push(`${label}-overage:${create.key}`), rows.set(idOf(where), create)),
    deleteMany: async ({ where }: { where: { key: string; tenantId?: { in: string[] }; packageId?: string } }) => {
      let count = 0;
      for (const [id, r] of rows) {
        const t = r as unknown as { tenantId?: string; packageId?: string };
        if (r.key === where.key && (!where.tenantId || where.tenantId.in.includes(t.tenantId as string)) && (!where.packageId || t.packageId === where.packageId)) count += rows.delete(id) ? 1 : 0;
      }
      return { count };
    },
  });

  const tx = {
    resellerLimitSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => (setting.has(where.key) ? { value: setting.get(where.key) } : null),
      findMany: async (args?: { where?: { key?: { in: string[] } } }) =>
        [...setting].map(([key, value]) => ({ key, value })).filter((r) => !args?.where?.key || args.where.key.in.includes(r.key)),
      upsert: async ({ where, create }: { where: { key: string }; create: { value: number | null } }) => (writes.push(`platform:${where.key}`), setting.set(where.key, create.value)),
      deleteMany: async ({ where }: { where: { key: string } }) => (writes.push(`platform-clear:${where.key}`), { count: setting.delete(where.key) ? 1 : 0 }),
    },
    packageLimit: {
      findUnique: async ({ where }: { where: { packageId_key: { packageId: string; key: string } } }) => {
        const k = `${where.packageId_key.packageId}:${where.packageId_key.key}`;
        return pkg.has(k) ? { value: pkg.get(k) } : null;
      },
      findMany: async () => [...pkg].map(([k, value]) => ({ packageId: k.split(':')[0], key: k.split(':')[1], value, package: { name: 'Growth' } })),
      upsert: async ({ where, create }: { where: { packageId_key: { packageId: string; key: string } }; create: { value: number | null } }) => {
        writes.push(`package:${where.packageId_key.key}`);
        pkg.set(`${where.packageId_key.packageId}:${where.packageId_key.key}`, create.value);
      },
      deleteMany: async ({ where }: { where: { packageId: string; key: string } }) => ({ count: pkg.delete(`${where.packageId}:${where.key}`) ? 1 : 0 }),
    },
    resellerLimit: {
      findMany: async ({ where }: { where: { key: string | { in: string[] }; tenantId?: string | { in: string[] } } }) =>
        [...own]
          .map(([k, v]) => ({ tenantId: k.split(':')[0], key: k.split(':')[1], ...v, tenant: { slug: 'acme' } }))
          .filter((r) => (typeof where.key === 'string' ? r.key === where.key : where.key.in.includes(r.key)))
          .filter((r) => !where.tenantId || (typeof where.tenantId === 'string' ? r.tenantId === where.tenantId : where.tenantId.in.includes(r.tenantId))),
      upsert: async ({ where, create }: { where: { tenantId_key: { tenantId: string; key: string } }; create: { value: number | null; reason: string } }) => {
        writes.push(`reseller:${where.tenantId_key.tenantId}`);
        own.set(`${where.tenantId_key.tenantId}:${where.tenantId_key.key}`, { value: create.value, reason: create.reason });
      },
      deleteMany: async ({ where }: { where: { tenantId: { in: string[] }; key: string } }) => {
        let count = 0;
        for (const t of where.tenantId.in) if (own.delete(`${t}:${where.key}`)) count++;
        writes.push(`reseller-clear:${count}`);
        return { count };
      },
    },
    quotaOverageSetting: overageTable(overage.platform, 'platform', (w) => w.key as string, () => ({})),
    packageQuotaOverage: overageTable(
      overage.pkg,
      'package',
      (w) => `${(w.packageId_key as { packageId: string }).packageId}:${(w.packageId_key as { key: string }).key}`,
      () => ({ package: { name: 'Growth' } }),
    ),
    resellerQuotaOverage: overageTable(
      overage.own,
      'reseller',
      (w) => `${(w.tenantId_key as { tenantId: string }).tenantId}:${(w.tenantId_key as { key: string }).key}`,
      () => ({ tenant: { slug: 'acme' } }),
    ),
    tenant: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => resellers.has(id)).map((id) => ({ id })),
      findUnique: async ({ where }: { where: { id: string } }) => (resellers.has(where.id) ? { tenantType: 'reseller' } : null),
      findFirst: async () => ({ operatingCurrencyCode: 'USD' }),
    },
    tenantSubscription: { findUnique: async () => null, findMany: async () => [] },
    tenantSubscriptionSetting: { findUnique: async () => ({ quotaTimeZone: 'Asia/Tehran' }) },
    resellerQuotaUsage: { aggregate: async () => ({ _sum: { includedQty: usage.sends || null, overageQty: null, overageAmount: null } }) },
    resellerOverageCap: {
      findUnique: async () => cap.row,
      upsert: async ({ create }: { create: { amount: unknown; currencyCode: string } }) => (writes.push('cap'), (cap.row = create)),
      delete: async () => (writes.push('cap-clear'), (cap.row = null)),
    },
    tenantFeaturePackage: { findUnique: async ({ where }: { where: { id: string } }) => (packages.has(where.id) ? { id: where.id } : null) },
    adminAuditLog: { create: async ({ data }: { data: Record<string, unknown> }) => (audit.push(data), {}) },
    grant: { count: async ({ where }: { where: { source?: string } }) => (where.source === 'admin_grant' ? usage.issued : usage.open) },
    tenantDomain: { count: async () => usage.domains },
    tenantStaffMember: { count: async () => usage.staff },
    notificationCampaign: { count: async () => usage.sends },
    user: { count: async () => usage.users },
    trafficDailyAggregate: { aggregate: async () => ({ _sum: { totalUploadBytes: BigInt(usage.gib) * BigInt(1024 ** 3), totalDownloadBytes: BigInt(0) } }) },
  };
  const prisma = { tenant: { findUnique: async () => ({ tenantType: opts.callerType ?? 'platform_owner' }) } };
  const all = { ...tx, $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) };
  const access = {
    admit: async (_actor: unknown, tenantId: string, capability: string) => {
      if (opts.refuse) throw new ResellerAccessRefused(opts.refuse, tenantId);
      admitted.push({ tenantId, capability });
      return { id: tenantId, slug: 'acme', as: 'owner' };
    },
  };
  return { service: new ResellerLimitsService(prisma as never, all as never, access as never), audit, writes, setting, own, admitted, overage };
}

const refusal = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ResellerLimitsRefused);
  return (e as ResellerLimitsRefused).reason;
};

describe('ResellerLimitsService', () => {
  it('refuses anyone but the platform owner, before anything is written', async () => {
    const { service, writes } = build({ callerType: 'reseller' });
    expect(await refusal(service.setPlatform(actor, 'custom_domains_max', 3))).toBe('not_platform_owner');
    expect(await refusal(service.table(actor))).toBe('not_platform_owner');
    expect(writes).toEqual([]);
  });

  it('refuses an unknown key and a value past the key\'s bound', async () => {
    const { service } = build();
    expect(await refusal(service.setPlatform(actor, 'nope', 3))).toBe('unknown_limit');
    expect(await refusal(service.setPlatform(actor, 'custom_domains_max', 1001))).toBe('limit_out_of_range');
  });

  it('sets and clears the platform\'s value, audited with before and after; null is a row meaning no limit', async () => {
    const { service, audit, setting } = build();
    await service.setPlatform(actor, 'custom_domains_max', 3);
    await service.setPlatform(actor, 'custom_domains_max', null);
    expect(setting.get('custom_domains_max')).toBeNull();
    expect(setting.has('custom_domains_max')).toBe(true);
    await service.clearPlatform(actor, 'custom_domains_max');
    expect(setting.has('custom_domains_max')).toBe(false);
    expect(audit.map((a) => [a.action, a.oldValue, a.newValue])).toEqual([
      ['reseller_limit_set', { level: 'platform', key: 'custom_domains_max', value: 'unset' }, { level: 'platform', key: 'custom_domains_max', value: 3 }],
      ['reseller_limit_set', { level: 'platform', key: 'custom_domains_max', value: 3 }, { level: 'platform', key: 'custom_domains_max', value: null }],
      ['reseller_limit_clear', { level: 'platform', key: 'custom_domains_max', value: null }, { level: 'platform', key: 'custom_domains_max', value: 'unset' }],
    ]);
    expect(audit[0]).toMatchObject({ tenantId: OWNER_TENANT, adminId: ADMIN, targetEntityType: 'tenant', targetEntityId: OWNER_TENANT, adminIpAddress: '203.0.113.1' });
  });

  it('sets a package\'s value against the package; an unknown package is refused', async () => {
    const { service, audit } = build();
    await service.setPackage(actor, PKG, 'platform_open_grants_max', 2000);
    expect(audit[0]).toMatchObject({ action: 'reseller_limit_set', targetEntityType: 'tenant_feature_package', targetEntityId: PKG });
    expect(await refusal(service.setPackage(actor, RESELLER_A, 'platform_open_grants_max', 1))).toBe('package_not_found');
  });

  it('sets several resellers in one request: one row and one audit row each, with the reason', async () => {
    const { service, audit, own } = build();
    const done = await service.setResellers(actor, 'admin_issues_30d_max', [RESELLER_A, RESELLER_B], 200, 'trusted, ticket 12');
    expect(done).toEqual({ key: 'admin_issues_30d_max', value: 200, tenantIds: [RESELLER_A, RESELLER_B] });
    expect(own.get(`${RESELLER_A}:admin_issues_30d_max`)).toEqual({ value: 200, reason: 'trusted, ticket 12' });
    expect(audit.map((a) => [a.targetEntityType, a.targetEntityId, a.reason])).toEqual([
      ['tenant', RESELLER_A, 'trusted, ticket 12'],
      ['tenant', RESELLER_B, 'trusted, ticket 12'],
    ]);
  });

  it('writes nothing for "several" when one of them is not a reseller', async () => {
    const { service, writes, audit } = build({ resellers: [RESELLER_A] });
    expect(await refusal(service.setResellers(actor, 'admin_issues_30d_max', [RESELLER_A, RESELLER_B], 200, 'x'))).toBe('reseller_not_found');
    expect(writes).toEqual([]);
    expect(audit).toEqual([]);
  });

  it('clears several resellers back to their package or the platform; audits only what existed', async () => {
    const { service, audit } = build();
    await service.setResellers(actor, 'custom_domains_max', [RESELLER_A], 9, 'r');
    audit.length = 0;
    await expect(service.clearResellers(actor, 'custom_domains_max', [RESELLER_A, RESELLER_B])).resolves.toEqual({ key: 'custom_domains_max', cleared: 1 });
    expect(audit).toEqual([expect.objectContaining({ action: 'reseller_limit_clear', targetEntityId: RESELLER_A })]);
  });

  it('answers the whole table: every key with its default, bound, platform value, packages and resellers', async () => {
    const { service } = build();
    await service.setPlatform(actor, 'custom_domains_max', 3);
    await service.setPackage(actor, PKG, 'custom_domains_max', 8);
    await service.setResellers(actor, 'custom_domains_max', [RESELLER_A], null, 'no limit for A');
    const table = await service.table(actor);
    expect(table.find((r) => r.key === 'custom_domains_max')).toEqual({
      key: 'custom_domains_max',
      kind: 'guard',
      codeDefault: 5,
      max: 1000,
      platform: { value: 3 },
      packages: [{ packageId: PKG, name: 'Growth', value: 8 }],
      resellers: [{ tenantId: RESELLER_A, slug: 'acme', value: null, reason: 'no limit for A' }],
      overage: null,
    });
    expect(table.find((r) => r.key === 'admin_issues_30d_max')).toMatchObject({ platform: null, packages: [], resellers: [] });
  });
});

describe('ResellerLimitsService overage (F-019-v1, ADR-0107)', () => {
  it('refuses overage on a guard key, before anything is written: a guard is never bought past', async () => {
    const { service, writes } = build();
    for (const key of ['custom_domains_max', 'platform_traffic_gib_monthly_max', 'user_purchases_daily_max']) {
      expect(await refusal(service.setPlatformOverage(actor, key, { mode: 'overage', unitPrice: '1.00' }))).toBe('not_a_quota');
      expect(await refusal(service.setPackageOverage(actor, PKG, key, { mode: 'stop' }))).toBe('not_a_quota');
      expect(await refusal(service.setResellersOverage(actor, key, [RESELLER_A], { mode: 'overage', unitPrice: '1' }, 'r'))).toBe('not_a_quota');
    }
    expect(await refusal(service.setPlatformOverage(actor, 'nope', { mode: 'stop' }))).toBe('unknown_limit');
    expect(writes).toEqual([]);
  });

  it('refuses anyone but the platform owner', async () => {
    const { service, writes } = build({ callerType: 'reseller' });
    expect(await refusal(service.setPlatformOverage(actor, 'campaign_sends_daily_max', { mode: 'overage', unitPrice: '1' }))).toBe('not_platform_owner');
    expect(writes).toEqual([]);
  });

  it('stamps the price with the platform\'s currency and audits before and after at each level', async () => {
    const { service, audit, overage } = build();
    await service.setPlatformOverage(actor, 'campaign_sends_daily_max', { mode: 'overage', unitPrice: '0.5' });
    expect(overage.platform.get('campaign_sends_daily_max')).toMatchObject({ mode: 'overage', currencyCode: 'USD' });
    await service.setPackageOverage(actor, PKG, 'campaign_sends_daily_max', { mode: 'stop' });
    await service.clearPlatformOverage(actor, 'campaign_sends_daily_max');
    await service.clearPlatformOverage(actor, 'campaign_sends_daily_max');
    expect(audit.map((a) => [a.action, a.targetEntityType, a.oldValue, a.newValue])).toEqual([
      [
        'reseller_overage_set',
        'tenant',
        { level: 'platform', key: 'campaign_sends_daily_max', overage: 'unset' },
        { level: 'platform', key: 'campaign_sends_daily_max', overage: { mode: 'overage', unitPrice: '0.50', currencyCode: 'USD' } },
      ],
      [
        'reseller_overage_set',
        'tenant_feature_package',
        { level: 'package', key: 'campaign_sends_daily_max', overage: 'unset' },
        { level: 'package', key: 'campaign_sends_daily_max', overage: { mode: 'stop', unitPrice: null, currencyCode: null } },
      ],
      [
        'reseller_overage_clear',
        'tenant',
        { level: 'platform', key: 'campaign_sends_daily_max', overage: { mode: 'overage', unitPrice: '0.50', currencyCode: 'USD' } },
        { level: 'platform', key: 'campaign_sends_daily_max', overage: 'unset' },
      ],
    ]);
    expect(await refusal(service.setPackageOverage(actor, RESELLER_A, 'campaign_sends_daily_max', { mode: 'stop' }))).toBe('package_not_found');
  });

  it('sets several resellers all or none, each with the reason; clears only what existed', async () => {
    const { service, audit, writes } = build({ resellers: [RESELLER_A] });
    expect(await refusal(service.setResellersOverage(actor, 'campaign_sends_daily_max', [RESELLER_A, RESELLER_B], { mode: 'stop' }, 'x'))).toBe('reseller_not_found');
    expect(writes).toEqual([]);
    const done = await service.setResellersOverage(actor, 'campaign_sends_daily_max', [RESELLER_A], { mode: 'overage', unitPrice: '2' }, 'big sender');
    expect(done).toEqual({ key: 'campaign_sends_daily_max', mode: 'overage', unitPrice: '2.00', currencyCode: 'USD', tenantIds: [RESELLER_A] });
    expect(audit[0]).toMatchObject({ action: 'reseller_overage_set', targetEntityId: RESELLER_A, reason: 'big sender' });
    await expect(service.clearResellersOverage(actor, 'campaign_sends_daily_max', [RESELLER_A, RESELLER_B])).resolves.toEqual({ key: 'campaign_sends_daily_max', cleared: 1 });
    await expect(service.clearResellersOverage(actor, 'campaign_sends_daily_max', [RESELLER_A])).resolves.toEqual({ key: 'campaign_sends_daily_max', cleared: 0 });
  });

  it('the table shows each quota\'s overage at every level, and none for a guard', async () => {
    const { service } = build();
    await service.setPlatformOverage(actor, 'campaign_sends_daily_max', { mode: 'overage', unitPrice: '1.25' });
    await service.setPackageOverage(actor, PKG, 'campaign_sends_daily_max', { mode: 'stop' });
    await service.setResellersOverage(actor, 'campaign_sends_daily_max', [RESELLER_A], { mode: 'overage', unitPrice: '0.75' }, 'deal');
    const table = await service.table(actor);
    expect(table.find((r) => r.key === 'campaign_sends_daily_max')).toMatchObject({
      kind: 'quota',
      overage: {
        platform: { mode: 'overage', unitPrice: '1.25', currencyCode: 'USD' },
        packages: [{ packageId: PKG, name: 'Growth', mode: 'stop', unitPrice: null, currencyCode: null }],
        resellers: [{ tenantId: RESELLER_A, slug: 'acme', reason: 'deal', mode: 'overage', unitPrice: '0.75', currencyCode: 'USD' }],
      },
    });
    expect(table.find((r) => r.key === 'staff_members_max')).toMatchObject({ kind: 'guard', overage: null });
  });

  it('a reseller\'s own number does not reset its overage: the two resolve apart', async () => {
    const { service } = build();
    await service.setPlatformOverage(actor, 'campaign_sends_daily_max', { mode: 'overage', unitPrice: '3' });
    await service.setResellers(actor, 'campaign_sends_daily_max', [RESELLER_A], 50, 'more room');
    const row = (await service.ofReseller({ userId: ADMIN, tenantId: RESELLER_A, permissions: [] }, RESELLER_A)).find((r) => r.key === 'campaign_sends_daily_max');
    expect(row).toMatchObject({ limit: 50, source: 'reseller', overage: { mode: 'overage', unitPrice: '3.00', currencyCode: 'USD', source: 'platform' } });
  });
});

describe('ResellerLimitsService.ofReseller (F-019-r, F-019-s)', () => {
  const owner = { userId: ADMIN, tenantId: RESELLER_A, permissions: [] };

  it('answers each key in effect, where it comes from and how much is used — the refusals\' own counts', async () => {
    const { service, admitted } = build({ usage: { open: 7, issued: 4, domains: 2, staff: 6, sends: 1, users: 120, gib: 37 } });
    await service.setPlatform(actor, 'custom_domains_max', 3);
    await service.setResellers(actor, 'admin_issues_30d_max', [RESELLER_A], null, 'trusted');
    const view = await service.ofReseller(owner, RESELLER_A);
    expect(admitted).toEqual([{ tenantId: RESELLER_A, capability: 'read' }]);
    expect(view).toEqual([
      { key: 'user_metered_cap_max', kind: 'guard', limit: 20, source: 'default', used: null, overage: null, statement: null , lockedUntil: null },
      { key: 'platform_open_grants_max', kind: 'guard', limit: 500, source: 'default', used: 7, overage: null, statement: null , lockedUntil: null },
      { key: 'admin_issues_30d_max', kind: 'guard', limit: null, source: 'reseller', used: 4, overage: null, statement: null , lockedUntil: null },
      { key: 'custom_domains_max', kind: 'guard', limit: 3, source: 'platform', used: 2, overage: null, statement: null , lockedUntil: null },
      { key: 'staff_members_max', kind: 'guard', limit: 20, source: 'default', used: 6, overage: null, statement: null , lockedUntil: null },
      { key: 'bulk_job_grants_max', kind: 'guard', limit: 10_000, source: 'default', used: null, overage: null, statement: null , lockedUntil: null },
      { key: 'campaign_sends_daily_max', kind: 'quota', limit: 10, source: 'default', used: 1, overage: { mode: 'stop', unitPrice: null, currencyCode: null, source: 'default' }, statement: { period: expect.objectContaining({ kind: 'day' }), includedUsed: 1, overageQty: 0, overageAmount: '0.00' } , lockedUntil: null },
      { key: 'end_users_max', kind: 'guard', limit: 50_000, source: 'default', used: 120, overage: null, statement: null , lockedUntil: null },
      { key: 'platform_traffic_gib_monthly_max', kind: 'guard', limit: null, source: 'default', used: 37, overage: null, statement: null , lockedUntil: null },
      { key: 'user_purchases_daily_max', kind: 'guard', limit: null, source: 'default', used: null, overage: null, statement: null , lockedUntil: null },
      { key: 'user_purchases_weekly_max', kind: 'guard', limit: null, source: 'default', used: null, overage: null, statement: null , lockedUntil: null },
      { key: 'user_purchases_monthly_max', kind: 'guard', limit: null, source: 'default', used: null, overage: null, statement: null , lockedUntil: null },
    ]);
  });

  it('the reseller sets its own overage cap through the billing door, in the platform\'s money, audited in its own log; null removes it', async () => {
    const { service, admitted, audit, writes } = build();
    const view = await service.setOverageCap({ ...owner, ip: '203.0.113.9' }, RESELLER_A, '25.5');
    expect(admitted).toEqual([{ tenantId: RESELLER_A, capability: 'tenantBilling' }]);
    expect(view).toMatchObject({ cap: '25.50', spent: '0.00', currencyCode: 'USD', month: expect.objectContaining({ kind: 'month' }) });
    expect(audit[0]).toMatchObject({
      tenantId: RESELLER_A,
      action: 'reseller_overage_cap_set',
      targetEntityId: RESELLER_A,
      oldValue: { cap: null },
      newValue: { cap: { amount: '25.50', currencyCode: 'USD' } },
    });
    await expect(service.setOverageCap({ ...owner, ip: '203.0.113.9' }, RESELLER_A, null)).resolves.toMatchObject({ cap: null });
    expect(audit[1]).toMatchObject({ oldValue: { cap: { amount: '25.50', currencyCode: 'USD' } }, newValue: { cap: null } });
    // Removing what is not there writes nothing.
    await service.setOverageCap({ ...owner, ip: '203.0.113.9' }, RESELLER_A, null);
    expect(writes.filter((w) => w.startsWith('cap'))).toEqual(['cap', 'cap-clear']);
    expect(audit).toHaveLength(2);
    await expect(service.overageCapOf(owner, RESELLER_A)).resolves.toMatchObject({ cap: null });
  });

  it('is ResellerAccess\'s door: whoever it refuses learns nothing', async () => {
    const { service } = build({ refuse: 'not_allowed' });
    const e = await service.ofReseller(owner, RESELLER_A).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ResellerAccessRefused);
    expect((e as ResellerAccessRefused).reason).toBe('not_allowed');
  });
});

describe('the bodies', () => {
  it('overage: stop, or overage with a positive price of at most 2 places, as a string', () => {
    expect(setOverageSchema.safeParse({ mode: 'stop' }).success).toBe(true);
    expect(setOverageSchema.safeParse({ mode: 'overage', unitPrice: '0.50' }).success).toBe(true);
    expect(setOverageSchema.safeParse({ mode: 'overage' }).success).toBe(false);
    expect(setOverageSchema.safeParse({ mode: 'overage', unitPrice: '0' }).success).toBe(false);
    expect(setOverageSchema.safeParse({ mode: 'overage', unitPrice: '0.001' }).success).toBe(false);
    expect(setOverageSchema.safeParse({ mode: 'overage', unitPrice: 1 }).success).toBe(false);
    expect(setOverageSchema.safeParse({ mode: 'stop', unitPrice: '1' }).success).toBe(false);
    expect(setOverageSchema.safeParse({ mode: 'bill_later' }).success).toBe(false);
    expect(setResellersOverageSchema.safeParse({ mode: 'stop', tenantIds: [RESELLER_A], reason: 'r' }).success).toBe(true);
    expect(setResellersOverageSchema.safeParse({ mode: 'overage', unitPrice: '1', tenantIds: [RESELLER_A] }).success).toBe(false);
    expect(setOverageCapSchema.safeParse({ amount: '0' }).success).toBe(true);
    expect(setOverageCapSchema.safeParse({ amount: null }).success).toBe(true);
    expect(setOverageCapSchema.safeParse({ amount: '-1' }).success).toBe(false);
    expect(setOverageCapSchema.safeParse({}).success).toBe(false);
  });

  it('a value is a whole number or null, and required', () => {
    expect(setLimitSchema.parse({ value: null })).toEqual({ value: null });
    expect(setLimitSchema.safeParse({}).success).toBe(false);
    expect(setLimitSchema.safeParse({ value: -1 }).success).toBe(false);
    expect(setLimitSchema.safeParse({ value: 1.5 }).success).toBe(false);
  });

  it('several resellers: 1..100 ids, no repeats, and a reason to set', () => {
    expect(setResellersLimitSchema.safeParse({ tenantIds: [RESELLER_A], value: 3, reason: 'ok' }).success).toBe(true);
    expect(setResellersLimitSchema.safeParse({ tenantIds: [], value: 3, reason: 'ok' }).success).toBe(false);
    expect(setResellersLimitSchema.safeParse({ tenantIds: [RESELLER_A, RESELLER_A], value: 3, reason: 'ok' }).success).toBe(false);
    expect(setResellersLimitSchema.safeParse({ tenantIds: [RESELLER_A], value: 3, reason: '  ' }).success).toBe(false);
    expect(clearResellersLimitSchema.safeParse({ tenantIds: [RESELLER_A] }).success).toBe(true);
  });
});
