/**
 * The self-move setting (F-410-a, D-63): whether a user may move their own
 * config to another server, and how long they wait between two moves —
 * resolved product override -> tenant -> platform (on, 24 h), as the selling
 * settings resolve (F-027-cg). What would break silently:
 *
 *  - **a setting nobody answers.** A tenant that set nothing still answers on
 *    and 24 h, so the move route never reads `undefined` as "off";
 *  - **a falsy value read as unset.** `enabled: false` and `cooldownHours: 0`
 *    at a layer are that layer's values, not "not set here";
 *  - **the wrong layer winning.** A product's override beats its tenant's,
 *    setting by setting, and each value names the layer it came from;
 *  - **the wrong tenant's row, or another tenant's product.** The tenant is the
 *    path's, admitted by the door; a product is the tenant's own or the
 *    platform's, else `product_not_found` before any write;
 *  - **a change nobody can account for.** Every change writes one audit row in
 *    its transaction; the same values again write neither row nor audit;
 *  - **a suspended reseller changing it.** Reads pass `read`, writes `staffWrite`.
 */
import { ResellerAccess, TenantContext } from '@txnet-backend/shared-core';

import { effectiveSelfMove, PLATFORM_SELF_MOVE_DEFAULTS } from './self-move-setting';
import { selfMoveOwnSchema } from './self-move-settings.schema';
import { SelfMoveSettingsService } from './self-move-settings.service';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const SUSPENDED = '33333333-3333-4333-8333-333333333333';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const STRANGER = '66666666-6666-4666-8666-666666666666';
const OWN_PRODUCT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PLATFORM_PRODUCT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHERS_PRODUCT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[], ip: '203.0.113.7' };
const stranger = { userId: STRANGER, tenantId: PLATFORM, permissions: [] as string[], ip: '203.0.113.9' };

const UNSET = { enabled: null, cooldownHours: null };

type Own = { enabled: boolean | null; cooldownHours: number | null };
type ProductRow = Own & { productId: string };

function build(seed: { tenant?: Own; products?: ProductRow[] } = {}) {
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
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ $executeRaw: async () => 1, adminAuditLog: { create: async () => ({}) } }),
  } as never);

  // Which tenant owns each product: the reseller's own, the platform's, another reseller's.
  const productTenant: Record<string, string> = { [OWN_PRODUCT]: RESELLER, [PLATFORM_PRODUCT]: PLATFORM, [OTHERS_PRODUCT]: SUSPENDED };
  let tenantRow: Own | null = seed.tenant ?? null;
  const productRows = new Map<string, Own>((seed.products ?? []).map((p) => [p.productId, { enabled: p.enabled, cooldownHours: p.cooldownHours }]));
  const audit: Array<Record<string, unknown>> = [];
  const writes: Array<{ what: string; scope: string | undefined; data: unknown }> = [];

  const tx = {
    $executeRaw: async () => 1,
    tenant: { findFirst: async () => ({ id: PLATFORM }) },
    product: {
      findFirst: async ({ where }: { where: { id: string; tenantId: { in: string[] } } }) =>
        where.tenantId.in.includes(productTenant[where.id] ?? '') ? { id: where.id } : null,
    },
    configSelfMoveSetting: {
      findUnique: async () => tenantRow,
      upsert: async (args: { create: Own & { tenantId: string } }) => {
        writes.push({ what: 'tenant.upsert', scope: scope(), data: args.create });
        tenantRow = { enabled: args.create.enabled, cooldownHours: args.create.cooldownHours };
        return tenantRow;
      },
      deleteMany: async () => {
        writes.push({ what: 'tenant.delete', scope: scope(), data: null });
        tenantRow = null;
        return { count: 1 };
      },
    },
    configSelfMoveProductSetting: {
      findUnique: async ({ where }: { where: { tenantId_productId: { productId: string } } }) => productRows.get(where.tenantId_productId.productId) ?? null,
      findMany: async () => [...productRows].map(([productId, row]) => ({ productId, ...row })),
      upsert: async (args: { create: ProductRow & { tenantId: string } }) => {
        writes.push({ what: 'product.upsert', scope: scope(), data: args.create });
        productRows.set(args.create.productId, { enabled: args.create.enabled, cooldownHours: args.create.cooldownHours });
        return args.create;
      },
      deleteMany: async ({ where }: { where: { productId: string } }) => {
        writes.push({ what: 'product.delete', scope: scope(), data: where.productId });
        productRows.delete(where.productId);
        return { count: 1 };
      },
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        audit.push(args.data);
        return { id: `audit-${audit.length}` };
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  return { service: new SelfMoveSettingsService(prisma as never, access), audit, writes };
}

describe('effectiveSelfMove — product -> tenant -> platform', () => {
  it('answers on and 24 hours from the platform when neither the product nor the tenant sets one', () => {
    expect(PLATFORM_SELF_MOVE_DEFAULTS).toEqual({ enabled: true, cooldownHours: 24 });
    expect(effectiveSelfMove(null, UNSET)).toEqual({ enabled: { value: true, layer: 'platform' }, cooldownHours: { value: 24, layer: 'platform' } });
    expect(effectiveSelfMove({}, {})).toEqual(effectiveSelfMove(null, UNSET));
  });

  it('takes the tenant over the platform, and the product over both, setting by setting', () => {
    expect(effectiveSelfMove({ enabled: null, cooldownHours: 6 }, { enabled: false, cooldownHours: 48 })).toEqual({
      enabled: { value: false, layer: 'tenant' },
      cooldownHours: { value: 6, layer: 'product' },
    });
  });

  it('reads `false` and `0` as values, never as "not set here"', () => {
    expect(effectiveSelfMove({ enabled: false, cooldownHours: 0 }, UNSET)).toEqual({
      enabled: { value: false, layer: 'product' },
      cooldownHours: { value: 0, layer: 'product' },
    });
  });
});

describe('SelfMoveSettingsService — the tenant layer', () => {
  it('reads the platform default, the tenant\'s own layer and what is in effect', async () => {
    await expect(build().service.settings(owner, RESELLER)).resolves.toEqual({
      platformDefault: { enabled: true, cooldownHours: 24 },
      tenant: UNSET,
      effective: { enabled: { value: true, layer: 'platform' }, cooldownHours: { value: 24, layer: 'platform' } },
      products: [],
    });
  });

  it('sets it in the path\'s tenant and audits before and after', async () => {
    const { service, audit, writes } = build();
    const view = await service.setTenant(owner, RESELLER, { enabled: true, cooldownHours: 72 });
    expect(view.effective.cooldownHours).toEqual({ value: 72, layer: 'tenant' });
    expect(writes).toEqual([{ what: 'tenant.upsert', scope: RESELLER, data: { tenantId: RESELLER, enabled: true, cooldownHours: 72, updatedByUserId: OWNER_USER } }]);
    expect(audit).toEqual([
      expect.objectContaining({
        tenantId: RESELLER,
        adminId: OWNER_USER,
        action: 'config_self_move_settings_set',
        targetEntityType: 'tenant',
        targetEntityId: RESELLER,
        newValue: { enabled: true, cooldownHours: 72 },
        adminIpAddress: '203.0.113.7',
      }),
    ]);
  });

  it('both unset removes the row: the platform answers again', async () => {
    const { service, writes } = build({ tenant: { enabled: false, cooldownHours: 12 } });
    const view = await service.setTenant(owner, RESELLER, UNSET);
    expect(writes).toEqual([{ what: 'tenant.delete', scope: RESELLER, data: null }]);
    expect(view.effective.enabled).toEqual({ value: true, layer: 'platform' });
  });

  it('the same values again write nothing; a suspended reseller reads but changes none; a stranger is refused', async () => {
    const same = build({ tenant: { enabled: true, cooldownHours: 24 } });
    await same.service.setTenant(owner, RESELLER, { enabled: true, cooldownHours: 24 });
    expect(same.writes).toHaveLength(0);
    expect(same.audit).toHaveLength(0);

    const late = build();
    await expect(late.service.settings(owner, SUSPENDED)).resolves.toMatchObject({ tenant: UNSET });
    await expect(late.service.setTenant(owner, SUSPENDED, { enabled: false, cooldownHours: null })).rejects.toMatchObject({ reason: 'reseller_suspended' });
    expect(late.writes).toHaveLength(0);

    await expect(build().service.settings(stranger, RESELLER)).rejects.toMatchObject({ reason: 'not_allowed' });
  });
});

describe('SelfMoveSettingsService — a product\'s override', () => {
  it('overrides the reseller\'s own product, or a platform product it sells, and names the layer', async () => {
    const { service, audit } = build({ tenant: { enabled: true, cooldownHours: 48 } });
    await service.setProduct(owner, RESELLER, OWN_PRODUCT, { enabled: null, cooldownHours: 0 });
    const view = await service.setProduct(owner, RESELLER, PLATFORM_PRODUCT, { enabled: false, cooldownHours: null });
    expect(view.products).toEqual([
      { productId: OWN_PRODUCT, enabled: null, cooldownHours: 0, effective: { enabled: { value: true, layer: 'tenant' }, cooldownHours: { value: 0, layer: 'product' } } },
      { productId: PLATFORM_PRODUCT, enabled: false, cooldownHours: null, effective: { enabled: { value: false, layer: 'product' }, cooldownHours: { value: 48, layer: 'tenant' } } },
    ]);
    expect(audit.map((a) => [a.targetEntityType, a.targetEntityId])).toEqual([
      ['product', OWN_PRODUCT],
      ['product', PLATFORM_PRODUCT],
    ]);
  });

  it('another tenant\'s product is `product_not_found`, before anything is written', async () => {
    const { service, writes, audit } = build();
    await expect(service.setProduct(owner, RESELLER, OTHERS_PRODUCT, { enabled: false, cooldownHours: null })).rejects.toMatchObject({ reason: 'product_not_found' });
    expect(writes).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it('both unset removes the override: the tenant answers again', async () => {
    const { service, writes } = build({ products: [{ productId: OWN_PRODUCT, enabled: false, cooldownHours: null }] });
    const view = await service.setProduct(owner, RESELLER, OWN_PRODUCT, UNSET);
    expect(writes).toEqual([{ what: 'product.delete', scope: RESELLER, data: OWN_PRODUCT }]);
    expect(view.products).toEqual([]);
  });
});

describe('the body', () => {
  it('both keys, each a value or null; the wait a whole number of hours from 0 to a year', () => {
    expect(selfMoveOwnSchema.parse({ enabled: false, cooldownHours: 0 })).toEqual({ enabled: false, cooldownHours: 0 });
    expect(selfMoveOwnSchema.parse(UNSET)).toEqual(UNSET);
    expect(selfMoveOwnSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(selfMoveOwnSchema.safeParse({ enabled: true, cooldownHours: 1.5 }).success).toBe(false);
    expect(selfMoveOwnSchema.safeParse({ enabled: true, cooldownHours: -1 }).success).toBe(false);
    expect(selfMoveOwnSchema.safeParse({ enabled: true, cooldownHours: 8761 }).success).toBe(false);
    expect(selfMoveOwnSchema.safeParse({ enabled: true, cooldownHours: 24, extra: 1 }).success).toBe(false);
  });
});
