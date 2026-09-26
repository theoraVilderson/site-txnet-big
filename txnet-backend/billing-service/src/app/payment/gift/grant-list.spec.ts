/**
 * A user's own Grants, listed (F-502-r): `GET /api/billing/gift/grants`.
 *
 * The list exists because a key is shown once (D-35) and the reissue button
 * (F-502-p, F-502-q) is reachable only while that key is on screen. So this is
 * the only route that says which Grants a user has at all, and three things
 * about it fail silently:
 *
 *  - **the subscription key.** A Grant's row carries `subscriptionTokenHash`,
 *    and a list that answered the row would hand out the hash of a live
 *    credential — or, on a later schema addition, something worse. The columns
 *    are selected explicitly and neither the key nor its hash is among them;
 *  - **whose Grants.** The user comes from the gate's header, never from the
 *    query, so there is no id here to authorise and no way to ask for someone
 *    else's list;
 *  - **the slice.** An echoed `page` can be right while the query read the
 *    wrong rows, so the `where`, the `skip`/`take` and the order are asserted
 *    on the query rather than on the answer.
 */
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConfigStatus, GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { RATE_LIMIT_KEY, RateLimitBucket, type RateLimitOptions, runWithTenant } from '@txnet-backend/shared-core';

import { GrantService } from '../../entitlement/grant';
import { GrantListController } from './grant-list.controller';
import { GRANT_LIST_QUERY_MAX, grantListSchema } from './grant-list.schema';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GRANT = '22222222-2222-4222-8222-222222222222';
const VARIANT = '66666666-6666-4666-8666-6666666666c1';

const req = (userId: string) => ({ identity: { userId, tenantId: TENANT, roleId: 'r', sessionId: 's', permissions: [] } });

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: GRANT,
    status: GrantStatus.active,
    startsAt: new Date('2026-09-14T10:00:00Z'),
    endsAt: new Date('2026-10-14T10:00:00Z'),
    featureKeys: ['vpn.access'],
    variant: { id: VARIANT, sku: 'vpn-30d', nameKey: null, product: { nameKey: 'catalog.product.vpn.name' } },
    billingMode: VariantBillingMode.metered,
    consumedBytes: BigInt('1500000000'),
    purchasedBytes: BigInt('2147483648'),
    trafficUnlimited: false,
    quotas: {},
    suspendedAt: null,
    purgeAfterDays: null,
    ...overrides,
  };
}

type Slice = { skip: number; take: number };

/** Records what the list was actually asked for — the `where`, the slice and the order. */
function build(
  rows: ReturnType<typeof grantRow>[] = [grantRow()],
  total = rows.length,
  tenantPurgeDays = 7,
  adjustments: { grantId: string; delta: bigint }[] = [],
  hidden = 0,
  search: { branding?: { brandName: string; lineNameTemplate: string | null } | null; regions?: string[] } = {},
) {
  const asked: {
    where?: Prisma.GrantWhereInput;
    counted: Prisma.GrantWhereInput[];
    slice?: Slice;
    orderBy?: unknown;
    select?: unknown;
    tenantReads: number;
    adjustmentsWhere?: Prisma.QuotaAdjustmentWhereInput;
    configReads: Prisma.ConfigWhereInput[];
  } = { tenantReads: 0, counted: [], configReads: [] };
  const tx = {
    tenant: {
      findUnique: async () => {
        asked.tenantReads += 1;
        return { purgeAfterDays: tenantPurgeDays };
      },
    },
    $executeRaw: async () => 0,
    tenantBranding: { findUnique: async () => search.branding ?? null },
    // The unlabelled live configs' panels: what a default name is made of.
    config: {
      findMany: async (args: { where: Prisma.ConfigWhereInput }) => {
        asked.configReads.push(args.where);
        return (search.regions ?? []).map((region) => ({ panel: { region } }));
      },
    },
    quotaAdjustment: {
      groupBy: async (args: { where: Prisma.QuotaAdjustmentWhereInput }) => {
        asked.adjustmentsWhere = args.where;
        const ids = (args.where.grantId as { in: string[] }).in;
        return ids.map((grantId) => ({
          grantId,
          _sum: { delta: adjustments.filter((a) => a.grantId === grantId).reduce((s, a) => s + a.delta, BigInt(0)) },
        }));
      },
    },
    grant: {
      findMany: async (args: { where: Prisma.GrantWhereInput; orderBy: unknown; select: unknown } & Slice) => {
        asked.where = args.where;
        asked.slice = { skip: args.skip, take: args.take };
        asked.orderBy = args.orderBy;
        asked.select = args.select;
        return rows;
      },
      // `total` Grants in the scope asked; `hidden` more exist outside it.
      count: async (args: { where: Prisma.GrantWhereInput }) => {
        asked.counted.push(args.where);
        return args.where.status ? total : total + hidden;
      },
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const grants = new GrantService(prisma as never);
  const list = (page?: number, pageSize?: number, scope?: 'current' | 'all', q?: string) =>
    runWithTenant({ id: TENANT }, () => grants.listForUser(USER, { page, pageSize, scope, q }));
  return { grants, list, asked };
}

describe('GrantService.listForUser', () => {
  it('answers one page of the user’s own Grants: id, variant, period, status, feature keys', async () => {
    const { list, asked } = build();

    const answer = await list();

    expect(asked.where).toEqual({ userId: USER, status: { notIn: [GrantStatus.cancelled, GrantStatus.exhausted] } });
    expect(answer).toEqual({
      total: 1,
      page: 1,
      pageSize: 20,
      hidden: 0,
      rows: [
        {
          id: GRANT,
          status: GrantStatus.active,
          startsAt: '2026-09-14T10:00:00.000Z',
          endsAt: '2026-10-14T10:00:00.000Z',
          featureKeys: ['vpn.access'],
          variant: { id: VARIANT, sku: 'vpn-30d', nameKey: 'catalog.product.vpn.name' },
          billingMode: VariantBillingMode.metered,
          consumedBytes: '1500000000',
          purchasedBytes: '2147483648',
          trafficUnlimited: false,
          trafficCapBytes: null,
          suspendedAt: null,
          purgeAt: null,
        },
      ],
    });
    // No suspended row, so the tenant's window is never asked for.
    expect(asked.tenantReads).toBe(0);
  });

  it('answers when a suspended Grant is purged — its own window, else the tenant’s, and 0 is never (F-027-ac)', async () => {
    const suspendedAt = new Date('2026-09-20T00:00:00Z');
    const { list, asked } = build(
      [
        grantRow({ status: GrantStatus.suspended, suspendedAt }),
        grantRow({ id: 'g-own', status: GrantStatus.suspended, suspendedAt, purgeAfterDays: 2 }),
        grantRow({ id: 'g-never', status: GrantStatus.suspended, suspendedAt, purgeAfterDays: 0 }),
        // A stale `suspendedAt` on a Grant that is not suspended starts no clock.
        grantRow({ id: 'g-live', suspendedAt }),
      ],
      4,
      7,
    );

    const { rows } = await list();

    expect(asked.tenantReads).toBe(1);
    expect(rows.map((r) => r.purgeAt)).toEqual(['2026-09-27T00:00:00.000Z', '2026-09-22T00:00:00.000Z', null, null]);
    expect(rows[0].suspendedAt).toBe('2026-09-20T00:00:00.000Z');
    expect(rows[3].suspendedAt).toBeNull();
  });

  it('says a Grant sold with unlimited traffic is unlimited, so its 0 bytes bought is not read as empty (F-111-s)', async () => {
    const { list, asked } = build([grantRow({ billingMode: VariantBillingMode.prepaid, purchasedBytes: BigInt(0), trafficUnlimited: true, endsAt: null })]);

    const { rows } = await list();

    expect(asked.select).toMatchObject({ trafficUnlimited: true });
    expect(rows[0]).toMatchObject({ purchasedBytes: '0', trafficUnlimited: true, endsAt: null });
  });

  it('answers a capped prepaid Grant its cap as /sub gives it — the limit plus unexpired adjustments; none for metered or unlimited (F-111-t)', async () => {
    const GIB = BigInt(1) << BigInt(30);
    const capped = grantRow({ id: 'g-capped', billingMode: VariantBillingMode.prepaid, quotas: { traffic_bytes: { limit: 10 * 2 ** 30 } } });
    const unlimited = grantRow({ id: 'g-unl', billingMode: VariantBillingMode.prepaid, trafficUnlimited: true, purchasedBytes: BigInt(0), quotas: { traffic_bytes: { limit: 0 } } });
    const metered = grantRow({ id: 'g-met', quotas: { traffic_bytes: { limit: 10 * 2 ** 30 } } });
    const { list, asked } = build([capped, unlimited, metered], 3, 7, [
      { grantId: 'g-capped', delta: BigInt(3) * GIB },
      { grantId: 'g-capped', delta: -GIB },
    ]);

    const { rows } = await list();

    expect(rows.map((r) => r.trafficCapBytes)).toEqual([(BigInt(12) * GIB).toString(), null, null]);
    // One read for the page, only for the rows with a cap, and only what has not expired.
    expect(asked.adjustmentsWhere).toMatchObject({ grantId: { in: ['g-capped'] }, metric: 'traffic_bytes' });
    expect(asked.adjustmentsWhere?.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
  });

  it('never reads adjustments for a page with no capped Grant', async () => {
    const { list, asked } = build();
    await list();
    expect(asked.adjustmentsWhere).toBeUndefined();
  });

  it('never reads the subscription key or its hash, whatever the schema grows', async () => {
    const { list, asked } = build([grantRow()]);

    const answer = await list();

    const select = JSON.stringify(asked.select);
    expect(select).not.toContain('subscriptionToken');
    expect(select).not.toContain('Hash');
    expect(JSON.stringify(answer)).not.toContain('subscriptionToken');
  });

  it('names the variant’s own wording over its product’s (§4.3), and a Grant with no variant is not a hole', async () => {
    const { list } = build([
      grantRow({ variant: { id: VARIANT, sku: 'vpn-30d', nameKey: 'catalog.variant.vpn30.name', product: { nameKey: 'catalog.product.vpn.name' } } }),
      grantRow({ id: '33333333-3333-4333-8333-333333333333', variant: null, endsAt: null }),
    ]);

    const { rows } = await list();

    expect(rows[0].variant).toEqual({ id: VARIANT, sku: 'vpn-30d', nameKey: 'catalog.variant.vpn30.name' });
    // A `migration` Grant was issued without a catalog item; `endsAt: null` is permanent.
    expect(rows[1]).toMatchObject({ variant: null, endsAt: null });
  });

  it('reads the slice it says it read, newest period first with the id breaking the tie', async () => {
    const { list, asked } = build([grantRow()], 42);

    const answer = await list(3, 5);

    expect(asked.slice).toEqual({ skip: 10, take: 5 });
    expect(asked.orderBy).toEqual([{ startsAt: 'desc' }, { id: 'desc' }]);
    expect(answer).toMatchObject({ total: 42, page: 3, pageSize: 5 });
  });

  it('leaves a cancelled or exhausted Grant out by default and says how many — expired and suspended stay (user, 2026-09-26)', async () => {
    const { list, asked } = build([grantRow({ status: GrantStatus.expired }), grantRow({ status: GrantStatus.suspended })], 2, 7, [], 3);

    const answer = await list();

    const current = { userId: USER, status: { notIn: [GrantStatus.cancelled, GrantStatus.exhausted] } };
    expect(asked.where).toEqual(current);
    expect(asked.counted).toEqual(expect.arrayContaining([current, { userId: USER }]));
    expect(answer).toMatchObject({ total: 2, hidden: 3 });
    expect(answer.rows.map((r) => r.status)).toEqual([GrantStatus.expired, GrantStatus.suspended]);
  });

  it('lists every Grant on scope=all — status is answered, and nothing is left out to count', async () => {
    const { list, asked } = build([grantRow({ status: GrantStatus.cancelled })]);

    const answer = await list(undefined, undefined, 'all');

    expect(asked.where).toEqual({ userId: USER });
    expect(asked.counted).toEqual([{ userId: USER }]);
    expect(answer).toMatchObject({ total: 1, hidden: 0 });
    expect(answer.rows[0].status).toBe(GrantStatus.cancelled);
  });
});

describe('GrantService.listForUser with q (F-307-m)', () => {
  const live = { not: ConfigStatus.retired };

  it('keeps a Grant holding a live config whose label, or unlabelled its default line name, holds q — case aside', async () => {
    const { list, asked } = build([grantRow()], 1, 7, [], 0, {
      branding: { brandName: 'Leaf', lineNameTemplate: '{brand} · {region}' },
      regions: ['Germany', 'Netherlands', 'Germany'],
    });

    await list(undefined, undefined, undefined, 'GERM');

    expect(asked.where).toEqual({
      userId: USER,
      status: { notIn: [GrantStatus.cancelled, GrantStatus.exhausted] },
      configs: {
        some: {
          status: live,
          OR: [{ userLabel: { contains: 'GERM', mode: 'insensitive' } }, { userLabel: null, panel: { region: { in: ['Germany'] } } }],
        },
      },
    });
    // Only the user's own unlabelled live configs are read to name them.
    expect(asked.configReads).toEqual([{ userId: USER, status: live, userLabel: null }]);
  });

  it('matches what the reseller’s template adds, not the region alone — the brand names every default line', async () => {
    const { list, asked } = build([grantRow()], 1, 7, [], 0, {
      branding: { brandName: 'Leaf', lineNameTemplate: '{brand} · {region}' },
      regions: ['Germany', 'Netherlands'],
    });

    await list(undefined, undefined, undefined, 'leaf');

    const some = (asked.where?.configs as { some: Prisma.ConfigWhereInput }).some;
    expect(some.OR?.[1]).toEqual({ userLabel: null, panel: { region: { in: ['Germany', 'Netherlands'] } } });
  });

  it('names by the platform’s template when the reseller set none, and a default name nothing matches is no region', async () => {
    const { list, asked } = build([], 0, 7, [], 0, { branding: null, regions: ['Germany'] });

    await list(undefined, undefined, undefined, 'x');

    const some = (asked.where?.configs as { some: Prisma.ConfigWhereInput }).some;
    expect(some.OR?.[1]).toEqual({ userLabel: null, panel: { region: { in: [] } } });
  });

  it('counts `hidden` among the Grants that match q, so an ended match is still said', async () => {
    const { list, asked } = build([grantRow()], 1, 7, [], 2, { regions: ['Germany'] });

    const answer = await list(undefined, undefined, undefined, 'germany');

    expect(answer.hidden).toBe(2);
    expect(asked.counted[1]).toEqual({ userId: USER, configs: asked.where?.configs });
  });

  it('an absent or blank q filters nothing and reads no config', async () => {
    const { list, asked } = build();

    await list(undefined, undefined, undefined, '');

    expect(asked.where).toEqual({ userId: USER, status: { notIn: [GrantStatus.cancelled, GrantStatus.exhausted] } });
    expect(asked.configReads).toEqual([]);
  });
});

describe('grantListSchema', () => {
  it('leaves an absent page absent — the service decides what absent means', () => {
    expect(grantListSchema.parse({})).toEqual({});
  });

  it('refuses a page a caller did send and cannot have', () => {
    expect(grantListSchema.safeParse({ page: 0 }).success).toBe(false);
    expect(grantListSchema.safeParse({ page: 'x' }).success).toBe(false);
    expect(grantListSchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(grantListSchema.parse({ page: '2', pageSize: '50' })).toEqual({ page: 2, pageSize: 50 });
  });

  it('takes a scope of current or all, and refuses any other', () => {
    expect(grantListSchema.parse({ scope: 'all' })).toEqual({ scope: 'all' });
    expect(grantListSchema.parse({ scope: 'current' })).toEqual({ scope: 'current' });
    expect(grantListSchema.safeParse({ scope: 'cancelled' }).success).toBe(false);
  });

  it('takes q trimmed, and refuses one longer than any line name can be', () => {
    expect(grantListSchema.parse({ q: '  Germany ' })).toEqual({ q: 'Germany' });
    expect(grantListSchema.safeParse({ q: 'x'.repeat(GRANT_LIST_QUERY_MAX + 1) }).success).toBe(false);
  });
});

describe('GrantListController', () => {
  it('passes the gate’s user, never one from the query', async () => {
    const grants = { listForUser: vi.fn(async () => ({ total: 0, page: 1, pageSize: 20, rows: [] })) };
    const controller = new GrantListController(grants as never);

    await controller.list({ page: 2 } as never, { ...req(USER), query: { userId: 'someone-else' } } as never);

    expect(grants.listForUser).toHaveBeenCalledWith(USER, { page: 2 });
  });

  it('is a GET on the gift box’s grants path, with a bucket of its own', () => {
    const handler = GrantListController.prototype.list;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(0); // RequestMethod.GET
    expect(Reflect.getMetadata(PATH_METADATA, GrantListController)).toBe('billing/gift/grants');

    const limit = Reflect.getMetadata(RATE_LIMIT_KEY, handler) as RateLimitOptions;
    expect(limit.configKey).toBe('GRANT_LIST_RATE_LIMIT');
    expect(limit.key(req(USER) as never)).toBe(`${RateLimitBucket.GRANT_LIST}:${USER}`);
    // Not the reissue budget: a page the panel refetches must not spend the
    // five calls a user has for recovering a key.
    expect(limit.key(req(USER) as never)).not.toContain(RateLimitBucket.GRANT_ROTATE_TOKEN);
  });
});
