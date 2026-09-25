/**
 * Catalog management (F-026-d, D-34, ADR-0049; spec F-0601, F-0602).
 *
 * The class reads and writes on the cross-tenant pool, so the boundary is its
 * own checks, and every way it breaks is silent:
 *
 *  - **ownership.** The platform owner manages platform items and every
 *    tenant's; any other tenant only its own. Another tenant's item is *not
 *    found*, so the surface never confirms it exists;
 *  - **whose category.** A tenant's product sits in its own category or the
 *    platform's shared one, never another tenant's;
 *  - **a price is history.** A change writes a new row and never edits the old;
 *    a price effective in the past is refused, because it would reprice an
 *    invoice already issued; a price is switched off, never deleted;
 *  - **a SKU is unique in its tenant**, and a second one is its own refusal;
 *  - **audit.** Every write leaves a row naming the actor and what changed;
 *  - **removal deletes only what was never sold** (F-026-h): a product the
 *    database lets go is deleted with its variants, one that anything
 *    references is archived instead — hidden, never sold again, and every
 *    Grant of it untouched; a category goes only when no product, archived
 *    included, sits in it (F-026-j) — asked to take its products with it, it
 *    removes only its own tenant's, then goes or is archived (F-026-l);
 *  - **names are the server's keys** (F-1533-d): a tenant's item is named under
 *    its own `t_<tenant>.` prefix, and a translation is reviewed only by
 *    whoever manages the item it names — the rules of the text itself are
 *    `catalog-texts.spec.ts`.
 *
 * What the database holds for every writer is `catalog-schema.int.spec.ts`.
 */
import { FulfilmentKind, Prisma, TenantType, VariantBillingMode, VariantVisibility } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { RETIRED_FULFILMENT_KINDS, createProductSchema } from './catalog-admin.schema';
import { CatalogAdminRefused, CatalogAdminService } from './catalog-admin.service';
import { CatalogTextService, catalogTextKey } from './catalog-texts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PLATFORM_CATEGORY = 'a0000000-0000-4000-8000-000000000001';
const OTHER_CATEGORY = 'a0000000-0000-4000-8000-000000000003';
/** The reseller's own categories: one holds a product, one is empty. */
const RESELLER_CATEGORY = 'a0000000-0000-4000-8000-000000000002';
const EMPTY_CATEGORY = 'a0000000-0000-4000-8000-000000000004';
const PLATFORM_PRODUCT = 'b0000000-0000-4000-8000-000000000001';
const RESELLER_PRODUCT = 'b0000000-0000-4000-8000-000000000002';
const OTHER_PRODUCT = 'b0000000-0000-4000-8000-000000000003';
const RESELLER_VARIANT = 'c0000000-0000-4000-8000-000000000002';
const RESELLER_PRICE = 'd0000000-0000-4000-8000-000000000002';
/** The reseller's second product: its variant backs a Grant, so it was sold. */
const SOLD_PRODUCT = 'b0000000-0000-4000-8000-000000000004';
const SOLD_VARIANT = 'c0000000-0000-4000-8000-000000000004';
const PLATFORM_GROUP = 'f0000000-0000-4000-8000-000000000001';
const RESELLER_GROUP = 'f0000000-0000-4000-8000-000000000002';
const OTHER_GROUP = 'f0000000-0000-4000-8000-000000000003';

const actor = (tenantId: string) => ({ adminId: ADMIN, tenantId, ip: '10.0.0.9' });

type Row = Record<string, unknown>;

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) =>
    v === undefined ||
    (k === 'OR'
      ? (v as Row[]).some((w) => matches(row, w))
      : v !== null && typeof v === 'object' && 'not' in v
        ? (row[k] ?? null) !== (v as { not: unknown }).not
        : (row[k] ?? null) === v),
  );

const unique = (message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code: 'P2002', clientVersion: 'test' });

/** What Postgres answers a delete an `ON DELETE RESTRICT` key refuses — Prisma leaves 23001 unmapped (catalog-schema.int.spec.ts). */
const referenced = (message: string) =>
  new Prisma.PrismaClientUnknownRequestError(`${message}: PostgresError { code: "23001", message: "violates RESTRICT setting" }`, { clientVersion: 'test' });

/**
 * Both pools over the same rows, every call logged as `app:` or `all:` (ADR-0053),
 * and every service call run in the actor's tenant, as `identity.middleware.ts` runs it.
 */
function pools(db: object) {
  const calls: string[] = [];
  const pool = (name: string) => {
    const client: Record<string, unknown> = { $executeRaw: async () => 0 };
    for (const [model, delegate] of Object.entries(db)) {
      client[model] = Object.fromEntries(
        Object.entries(delegate as Row)
          .filter(([, fn]) => typeof fn === 'function')
          .map(([op, fn]) => [op, (...args: unknown[]) => (calls.push(`${name}:${model}.${op}`), (fn as (...a: unknown[]) => unknown)(...args))]),
      );
    }
    client['$transaction'] = async (fn: (tx: unknown) => unknown) => fn(client);
    return client;
  };
  return { app: pool('app'), all: pool('all'), calls };
}

function inTenant<T extends object>(service: T): T {
  return new Proxy(service, {
    get: (target, key) => {
      const v = Reflect.get(target, key) as unknown;
      if (typeof v !== 'function') return v;
      return (actor: { tenantId: string }, ...rest: unknown[]) => runWithTenant({ id: actor.tenantId }, () => v.call(target, actor, ...rest));
    },
  });
}

/** `held`: whether a foreign key elsewhere still points at an id — deleting one fails as Postgres's RESTRICT does. */
function table(rows: Row[], name: string, writes: string[], uniqueOn: string[] = [], held: (id: string) => boolean = () => false) {
  let next = 0;
  const remove = (where: Row) => {
    const gone = rows.filter((r) => matches(r, where));
    if (gone.some((r) => held(r['id'] as string))) throw referenced(`${name}: still referenced`);
    writes.push(`${name}.delete`);
    for (const r of gone) rows.splice(rows.indexOf(r), 1);
    return gone;
  };
  return {
    rows,
    findMany: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)),
    findUnique: async ({ where }: { where: Row }) => rows.find((r) => matches(r, where)) ?? null,
    findFirst: async ({ where }: { where?: Row } = {}) => rows.find((r) => matches(r, where)) ?? null,
    count: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)).length,
    create: async ({ data }: { data: Row }) => {
      if (uniqueOn.length && rows.some((r) => uniqueOn.every((k) => (r[k] ?? null) === (data[k] ?? null)))) {
        throw unique(`${name}: ${uniqueOn.join(', ')}`);
      }
      writes.push(`${name}.create`);
      const row = { id: `e0000000-0000-4000-8000-0000000000${String(next++).padStart(2, '0')}`, isActive: true, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      writes.push(`${name}.update`);
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error(`${name}: no row`);
      return Object.assign(row, data);
    },
    delete: async ({ where }: { where: Row }) => {
      const [row] = remove(where);
      if (!row) throw new Error(`${name}: no row`);
      return row;
    },
    deleteMany: async ({ where }: { where: Row }) => ({ count: remove(where).length }),
  };
}

function build() {
  const writes: string[] = [];
  const audit: Row[] = [];
  const types: Record<string, TenantType> = { [OWNER]: TenantType.platform_owner, [RESELLER]: TenantType.reseller, [OTHER]: TenantType.reseller };
  const product = (id: string, tenantId: string | null, key: string, categoryId = PLATFORM_CATEGORY): Row => ({
    id, tenantId, categoryId, key, nameKey: `catalog.product.${key}.name`, descriptionKey: null,
    fulfilmentKind: FulfilmentKind.network_access, featureKeys: ['vpn.access'], defaultQuotas: {}, isActive: true,
  });
  const products = [
    product(PLATFORM_PRODUCT, null, 'vpn_basic'),
    product(RESELLER_PRODUCT, RESELLER, 'vpn_alpha'),
    product(OTHER_PRODUCT, OTHER, 'followers_1k', OTHER_CATEGORY),
    product(SOLD_PRODUCT, RESELLER, 'vpn_sold'),
  ];
  const db = {
    tenant: table(Object.entries(types).map(([id, tenantType]) => ({ id, tenantType })), 'tenant', writes),
    productCategory: table(
      [
        { id: PLATFORM_CATEGORY, tenantId: null, key: 'vpn', nameKey: 'catalog.category.vpn.name', isActive: true },
        { id: OTHER_CATEGORY, tenantId: OTHER, key: 'followers', nameKey: 'catalog.category.followers.name', isActive: true },
      ],
      'productCategory',
      writes,
      ['tenantId', 'key'],
      // product.categoryId is ON DELETE RESTRICT: any product, archived or not, holds its category.
      (id) => products.some((p) => p['categoryId'] === id),
    ),
    product: table(
      products,
      'product',
      writes,
      ['tenantId', 'key'],
    ),
    productVariant: table(
      [
        {
          id: RESELLER_VARIANT, tenantId: RESELLER, productId: RESELLER_PRODUCT, sku: 'VPN-30', nameKey: null, quotas: {},
          durationDays: 30, billingMode: VariantBillingMode.prepaid, visibility: VariantVisibility.public, panelGroupId: null,
          qualityTier: 'standard', isActive: true,
        },
        {
          id: SOLD_VARIANT, tenantId: RESELLER, productId: SOLD_PRODUCT, sku: 'VPN-SOLD', nameKey: null, quotas: {},
          durationDays: 30, billingMode: VariantBillingMode.prepaid, visibility: VariantVisibility.public, panelGroupId: null,
          qualityTier: 'standard', isActive: true,
        },
      ],
      'productVariant',
      writes,
      ['tenantId', 'sku'],
      (id) => id === SOLD_VARIANT,
    ),
    panelGroup: table(
      [
        {
          id: PLATFORM_GROUP, tenantId: null, name: 'Europe', strategy: 'mirror', protocol: 'vless',
          members: [
            { role: 'primary', panel: { reviewState: 'accepted', panelState: 'healthy' } },
            { role: 'replica', panel: { reviewState: 'accepted_low_trust', panelState: 'healthy' } },
            { role: 'drain', panel: { reviewState: 'accepted', panelState: 'healthy' } },
            { role: 'primary', panel: { reviewState: 'accepted', panelState: 'degraded' } },
            { role: 'primary', panel: { reviewState: 'pending_review', panelState: 'healthy' } },
          ],
        },
        { id: RESELLER_GROUP, tenantId: RESELLER, name: 'Alpha own', strategy: 'mirror', protocol: 'vmess', members: [] },
        { id: OTHER_GROUP, tenantId: OTHER, name: 'Other own', strategy: 'priority', protocol: 'vless', members: [] },
      ],
      'panelGroup',
      writes,
    ),
    price: table(
      [{ id: RESELLER_PRICE, tenantId: RESELLER, variantId: RESELLER_VARIANT, amount: new Prisma.Decimal('5.00'), effectiveFrom: new Date('2026-01-01T00:00:00Z'), isActive: true, createdByAdminId: ADMIN }],
      'price',
      writes,
    ),
    adminAuditLog: {
      create: async ({ data }: { data: Row }) => {
        writes.push('audit');
        audit.push(data);
        return data;
      },
    },
  };
  const { app, all, calls } = pools(db);
  // What reached locale-service, in order. The text rules themselves are catalog-texts.spec.ts.
  const texts: string[] = [];
  const textService = {
    languages: () => ['de', 'en', 'fa'],
    defaultLanguage: () => 'fa',
    publishSources: async (t: { key: string; text: Record<string, string> }[]) => {
      writes.push('texts.publish');
      texts.push(...t.map((x) => `publish ${x.key} ${Object.entries(x.text).map(([l, v]) => `${l}=${v}`).join(' ')}`));
    },
    clear: async (keys: string[]) => {
      texts.push(...keys.map((k) => `clear ${k}`));
    },
    draftOthers: async (t: { key: string; from: string; written: string[] }[]) => {
      texts.push(...t.map((x) => `draft ${x.key} from ${x.from} skipping ${x.written.join(',')}`));
      return t.length;
    },
    reviewList: async (sources: Map<string, string>) =>
      [...sources].map(([key, from]) => ({ lang: 'de', key, draft: 'x', published: null, source: { lang: from, text: null } })),
    draftMissing: async (items: { key: string; from: string }[]) => items.length,
    publishDrafts: async (lang: string, keys: string[]) => {
      texts.push(...keys.map((k) => `publish-draft ${lang} ${k}`));
      return keys.length;
    },
    publishEdited: async (lang: string, t: Record<string, string>) => {
      texts.push(...Object.keys(t).map((k) => `publish-edited ${lang} ${k}`));
      return Object.keys(t).length;
    },
  };
  return { service: inTenant(new CatalogAdminService(app as never, all as never, textService as unknown as CatalogTextService)), db, writes, audit, texts, calls, product };
}

async function refusal(run: () => Promise<unknown>): Promise<CatalogAdminRefused> {
  try {
    await run();
  } catch (e) {
    if (e instanceof CatalogAdminRefused) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

const NEW_PRODUCT = { categoryId: PLATFORM_CATEGORY, key: 'vpn_pro', name: { fa: 'وی‌پی‌ان پرو', en: 'VPN Pro' }, fulfilmentKind: FulfilmentKind.network_access };
const NEW_VARIANT = { sku: 'VPN-90', billingMode: VariantBillingMode.prepaid, visibility: VariantVisibility.public, durationDays: 90, price: '12.00' };

describe('createProductSchema — a retired kind is never created (F-111-g)', () => {
  const body = (fulfilmentKind: string) => ({ ...NEW_PRODUCT, fulfilmentKind });

  it('refuses `wallet_topup`: a top-up is the deposit page, and from the wallet it is circular', () => {
    expect(RETIRED_FULFILMENT_KINDS).toEqual([FulfilmentKind.wallet_topup]);
    expect(createProductSchema.safeParse(body(FulfilmentKind.wallet_topup)).success).toBe(false);
  });

  it('accepts every kind that is not retired', () => {
    const live = Object.values(FulfilmentKind).filter((k) => !(RETIRED_FULFILMENT_KINDS as readonly string[]).includes(k));
    expect(live.length).toBeGreaterThan(0);
    for (const k of live) expect(createProductSchema.safeParse(body(k)).success).toBe(true);
  });
});

describe('CatalogAdminService — who manages which item', () => {
  it("refuses a platform product, or another tenant's, to a reseller", async () => {
    const { service, audit } = build();
    expect((await refusal(() => service.createProduct(actor(RESELLER), { ...NEW_PRODUCT, tenantId: null }))).reason).toBe('not_platform_owner');
    expect((await refusal(() => service.createProduct(actor(RESELLER), { ...NEW_PRODUCT, tenantId: OTHER }))).reason).toBe('not_platform_owner');
    expect(audit).toHaveLength(0);
  });

  it("lets the platform owner create a product for another tenant, audited against that tenant", async () => {
    const { service, audit } = build();
    const view = await service.createProduct(actor(OWNER), { ...NEW_PRODUCT, tenantId: OTHER });
    expect(view.tenantId).toBe(OTHER);
    expect(audit).toEqual([expect.objectContaining({ tenantId: OTHER, adminId: ADMIN, action: 'catalog_product_create', targetEntityId: view.id })]);
  });

  it("puts a reseller's product in its own tenant when it names none", async () => {
    const { service } = build();
    await expect(service.createProduct(actor(RESELLER), NEW_PRODUCT)).resolves.toMatchObject({ tenantId: RESELLER });
  });

  it("answers another tenant's product, and the platform's, as not found to a reseller", async () => {
    const { service, writes } = build();
    expect((await refusal(() => service.getProduct(actor(RESELLER), OTHER_PRODUCT))).reason).toBe('product_not_found');
    expect((await refusal(() => service.updateProduct(actor(RESELLER), PLATFORM_PRODUCT, { isActive: false }))).reason).toBe('product_not_found');
    expect(writes).toEqual([]);
  });

  it("refuses a tenant's product in another tenant's category", async () => {
    const { service } = build();
    expect((await refusal(() => service.createProduct(actor(RESELLER), { ...NEW_PRODUCT, categoryId: OTHER_CATEGORY }))).reason).toBe('category_not_found');
  });
});

describe('CatalogAdminService — variants and prices', () => {
  it("gives a variant its product's tenant and writes its first price", async () => {
    const { service, db, audit } = build();
    const view = await service.createVariant(actor(OWNER), RESELLER_PRODUCT, NEW_VARIANT);
    expect(view).toMatchObject({ tenantId: RESELLER, productId: RESELLER_PRODUCT, sku: 'VPN-90' });
    expect(view.prices).toEqual([expect.objectContaining({ amount: '12.00', isActive: true })]);
    expect(db.price.rows.at(-1)).toMatchObject({ tenantId: RESELLER, variantId: view.id });
    expect(audit.map((a) => a['action'])).toEqual(['catalog_variant_create']);
  });

  it('refuses a SKU the tenant already sells', async () => {
    const { service } = build();
    expect((await refusal(() => service.createVariant(actor(RESELLER), RESELLER_PRODUCT, { ...NEW_VARIANT, sku: 'VPN-30' }))).reason).toBe('sku_taken');
  });

  it('writes a price change as a new row and leaves the old one as it was', async () => {
    const { service, db, writes, audit } = build();
    const before = { ...db.price.rows[0] };

    const price = await service.setPrice(actor(RESELLER), RESELLER_VARIANT, { amount: '7.00' });

    expect(price).toMatchObject({ variantId: RESELLER_VARIANT, amount: '7.00', isActive: true });
    expect(db.price.rows).toHaveLength(2);
    expect(db.price.rows[0]).toEqual(before);
    expect(writes).not.toContain('price.update');
    expect(audit.map((a) => a['action'])).toEqual(['catalog_price_set']);
  });

  it('refuses a price effective in the past — it would reprice an invoice already issued', async () => {
    const { service, db } = build();
    const past = await refusal(() => service.setPrice(actor(RESELLER), RESELLER_VARIANT, { amount: '7.00', effectiveFrom: '2020-01-01T00:00:00Z' }));
    expect(past.reason).toBe('price_in_the_past');
    expect(db.price.rows).toHaveLength(1);
    await expect(
      service.setPrice(actor(RESELLER), RESELLER_VARIANT, { amount: '7.00', effectiveFrom: '2099-01-01T00:00:00Z' }),
    ).resolves.toMatchObject({ amount: '7.00' });
  });

  it('switches a price off and never deletes it', async () => {
    const { service, db, writes, audit } = build();
    await expect(service.deactivatePrice(actor(RESELLER), RESELLER_PRICE)).resolves.toMatchObject({ id: RESELLER_PRICE, isActive: false });
    expect(db.price.rows).toHaveLength(1);
    expect(writes.filter((w) => w.startsWith('price.'))).toEqual(['price.update']);
    expect(audit.map((a) => a['action'])).toEqual(['catalog_price_deactivate']);
  });

  it("provisions on the platform's panel groups or the tenant's own, never another tenant's (F-027-bk)", async () => {
    const { service, db } = build();
    await expect(service.createVariant(actor(RESELLER), RESELLER_PRODUCT, { ...NEW_VARIANT, panelGroupId: PLATFORM_GROUP })).resolves.toMatchObject({ panelGroupId: PLATFORM_GROUP });
    await expect(service.updateVariant(actor(RESELLER), RESELLER_VARIANT, { panelGroupId: RESELLER_GROUP })).resolves.toMatchObject({ panelGroupId: RESELLER_GROUP });
    // Another tenant's group is not found, as its variant is: the surface never confirms it exists.
    expect((await refusal(() => service.updateVariant(actor(RESELLER), RESELLER_VARIANT, { panelGroupId: OTHER_GROUP }))).reason).toBe('panel_group_not_found');
    expect((await refusal(() => service.createVariant(actor(RESELLER), RESELLER_PRODUCT, { ...NEW_VARIANT, sku: 'VPN-7', panelGroupId: 'f0000000-0000-4000-8000-0000000000ff' }))).reason).toBe('panel_group_not_found');
    // The platform owner acting on a reseller's variant is held to the variant's tenant, not its own.
    expect((await refusal(() => service.updateVariant(actor(OWNER), RESELLER_VARIANT, { panelGroupId: OTHER_GROUP }))).reason).toBe('panel_group_not_found');
    expect(db.productVariant.rows.find((r) => r['id'] === RESELLER_VARIANT)?.['panelGroupId']).toBe(RESELLER_GROUP);
    await expect(service.updateVariant(actor(RESELLER), RESELLER_VARIANT, { panelGroupId: null })).resolves.toMatchObject({ panelGroupId: null });
  });

  it("answers another tenant's variant as not found, to change or to price", async () => {
    const { service } = build();
    expect((await refusal(() => service.setPrice(actor(OTHER), RESELLER_VARIANT, { amount: '1.00' }))).reason).toBe('variant_not_found');
    expect((await refusal(() => service.updateVariant(actor(OTHER), RESELLER_VARIANT, { isActive: false }))).reason).toBe('variant_not_found');
  });
});

describe('CatalogAdminService — the panel groups a variant may name (F-026-p)', () => {
  it("offers a tenant the platform's groups and its own, never another tenant's", async () => {
    const { service } = build();
    const ids = (await service.listPanelGroups(actor(RESELLER))).map((g) => g.id);
    expect(ids.sort()).toEqual([PLATFORM_GROUP, RESELLER_GROUP].sort());
  });

  it('offers the platform owner every group, each with its tenant, so a variant is matched to its own', async () => {
    const { service } = build();
    const groups = await service.listPanelGroups(actor(OWNER));
    expect(groups.map((g) => [g.id, g.tenantId]).sort()).toEqual(
      [[PLATFORM_GROUP, null], [RESELLER_GROUP, RESELLER], [OTHER_GROUP, OTHER]].sort(),
    );
  });

  it('counts a member healthy only where fulfilment would place: not drain, accepted, healthy', async () => {
    const { service } = build();
    const [europe] = (await service.listPanelGroups(actor(RESELLER))).filter((g) => g.id === PLATFORM_GROUP);
    expect(europe).toEqual({ id: PLATFORM_GROUP, tenantId: null, name: 'Europe', strategy: 'mirror', protocol: 'vless', healthyMembers: 2 });
  });

  it('reads on the pool that serves the caller and writes nothing', async () => {
    const { service, calls, writes } = build();
    await service.listPanelGroups(actor(RESELLER));
    await service.listPanelGroups(actor(OWNER));
    expect(calls.filter((c) => c.includes('panelGroup'))).toEqual(['app:panelGroup.findMany', 'all:panelGroup.findMany']);
    expect(writes).toEqual([]);
  });
});

describe('CatalogAdminService — names (F-1533-d)', () => {
  it("names a tenant's product under its own prefix and the platform's without one", async () => {
    const { service, texts } = build();
    const mine = await service.createProduct(actor(RESELLER), NEW_PRODUCT);
    const platform = await service.createProduct(actor(OWNER), { ...NEW_PRODUCT, tenantId: null });

    expect(mine.nameKey).toBe(catalogTextKey(RESELLER, 'product', 'vpn_pro', 'name'));
    expect(platform.nameKey).toBe('catalog.product.vpn_pro.name');
    expect(mine.descriptionKey).toBeNull();
    expect(mine.sourceLang).toBe('fa'); // DEFAULT_LANGUAGE when none was picked
    // Published inside the write, drafted after it.
    expect(texts).toEqual([
      `publish ${mine.nameKey} fa=وی‌پی‌ان پرو en=VPN Pro`,
      `draft ${mine.nameKey} from fa skipping fa,en`,
      `publish ${platform.nameKey} fa=وی‌پی‌ان پرو en=VPN Pro`,
      `draft ${platform.nameKey} from fa skipping fa,en`,
    ]);
  });

  it('writes the name inside the transaction, after the row and its audit', async () => {
    const { service, writes } = build();
    await service.createCategory(actor(RESELLER), { key: 'games', name: { fa: 'بازی' } });
    expect(writes).toEqual(['productCategory.create', 'audit', 'texts.publish']);
  });

  it('re-keys an edited name to the derived key, and removes a description set to null', async () => {
    const { service, db, texts } = build();
    db.product.rows[1]['nameKey'] = 'catalog.product.hand_typed.name';
    db.product.rows[1]['descriptionKey'] = 'catalog.product.hand_typed.description';

    const view = await service.updateProduct(actor(RESELLER), RESELLER_PRODUCT, { name: { fa: 'آلفا', en: 'Alpha' }, description: null });

    expect(view.nameKey).toBe(catalogTextKey(RESELLER, 'product', 'vpn_alpha', 'name'));
    expect(view.descriptionKey).toBeNull();
    expect(texts).toContain(`clear ${catalogTextKey(RESELLER, 'product', 'vpn_alpha', 'description')}`);
  });

  it("shows a reseller only its own items' drafts, each with its item's source language, and the owner every one", async () => {
    const { service, db } = build();
    db.product.rows[1]['sourceLang'] = 'en';
    const mine = await service.listTextDrafts(actor(RESELLER));
    expect(mine.map((d) => [d.key, d.source.lang])).toEqual([
      [catalogTextKey(RESELLER, 'product', 'vpn_alpha', 'name'), 'en'],
      [catalogTextKey(RESELLER, 'product', 'vpn_alpha', 'description'), 'en'],
      [catalogTextKey(RESELLER, 'product', 'vpn_sold', 'name'), 'fa'],
      [catalogTextKey(RESELLER, 'product', 'vpn_sold', 'description'), 'fa'],
    ]);
    // 2 categories + 4 products × (name, description)
    expect(await service.listTextDrafts(actor(OWNER))).toHaveLength(10);
    await expect(service.draftMissingTexts(actor(RESELLER))).resolves.toEqual({ drafted: 4 });
  });

  it('writes in the source language the admin picks, and drafts every other language from it', async () => {
    const { service, db, texts } = build();
    const view = await service.createProduct(actor(RESELLER), { ...NEW_PRODUCT, sourceLang: 'en', name: { en: 'VPN Pro' } });
    expect(view.sourceLang).toBe('en');
    expect(db.product.rows.at(-1)).toMatchObject({ sourceLang: 'en' });
    expect(texts).toEqual([`publish ${view.nameKey} en=VPN Pro`, `draft ${view.nameKey} from en skipping en`]);
  });

  it('refuses a language locale-service does not have, or text that leaves out the source language', async () => {
    const { service, writes } = build();
    expect((await refusal(() => service.createProduct(actor(RESELLER), { ...NEW_PRODUCT, sourceLang: 'xx', name: { xx: 'x' } }))).reason).toBe('lang_unknown');
    expect((await refusal(() => service.createProduct(actor(RESELLER), { ...NEW_PRODUCT, name: { en: 'only English' } }))).reason).toBe('source_text_missing');
    expect((await refusal(() => service.createProduct(actor(RESELLER), { ...NEW_PRODUCT, description: { en: 'About' } }))).reason).toBe('source_text_missing');
    expect((await refusal(() => service.updateCategory(actor(OWNER), PLATFORM_CATEGORY, { sourceLang: 'en' }))).reason).toBe('source_text_missing');
    expect(writes).toEqual([]);
  });

  it("refuses to publish a translation of an item the caller does not manage, and writes nothing", async () => {
    const { service, audit, texts } = build();
    const platformName = catalogTextKey(null, 'product', 'vpn_basic', 'name');
    const othersName = catalogTextKey(OTHER, 'product', 'followers_1k', 'name');

    expect((await refusal(() => service.publishTextDrafts(actor(RESELLER), { lang: 'de', keys: [platformName] }))).reason).toBe('product_not_found');
    expect((await refusal(() => service.editTexts(actor(RESELLER), { lang: 'de', texts: { [othersName]: 'x' } }))).reason).toBe('product_not_found');
    expect((await refusal(() => service.publishTextDrafts(actor(RESELLER), { lang: 'de', keys: ['errors.auth.x'] }))).reason).toBe('text_key_invalid');
    expect(audit).toHaveLength(0);
    expect(texts).toEqual([]);
  });

  it('publishes a translation of its own item, audited on that item', async () => {
    const { service, audit, texts } = build();
    const key = catalogTextKey(RESELLER, 'product', 'vpn_alpha', 'name');
    await expect(service.editTexts(actor(RESELLER), { lang: 'de', texts: { [key]: 'Alpha' } })).resolves.toEqual({ published: 1 });
    expect(texts).toEqual([`publish-edited de ${key}`]);
    expect(audit).toEqual([
      expect.objectContaining({ tenantId: RESELLER, action: 'catalog_product_update', targetEntityId: RESELLER_PRODUCT, newValue: { texts: { lang: 'de', edited: { [key]: 'Alpha' } } } }),
    ]);
  });
});

describe('CatalogAdminService — the pool follows the caller (ADR-0053)', () => {
  it("serves a reseller's every catalog read and write on the app pool", async () => {
    const { service, calls } = build();
    const product = await service.createProduct(actor(RESELLER), NEW_PRODUCT);
    await service.updateProduct(actor(RESELLER), product.id, { isActive: false });
    const variant = await service.createVariant(actor(RESELLER), product.id, NEW_VARIANT);
    await service.updateVariant(actor(RESELLER), variant.id, { isActive: false });
    await service.setPrice(actor(RESELLER), variant.id, { amount: '13.00' });
    await service.deactivatePrice(actor(RESELLER), RESELLER_PRICE);
    await service.getProduct(actor(RESELLER), RESELLER_PRODUCT);
    await service.listProducts(actor(RESELLER));
    await service.listTextDrafts(actor(RESELLER));
    expect(calls.filter((c) => c.startsWith('all:'))).toEqual([]);
    expect(calls).toContain('app:product.create');
    expect(calls).toContain('app:adminAuditLog.create');
  });

  it('serves the platform owner on the cross-tenant pool, where a platform item can be written', async () => {
    const { service, calls } = build();
    await service.createProduct(actor(OWNER), { ...NEW_PRODUCT, tenantId: null });
    await service.getProduct(actor(OWNER), OTHER_PRODUCT);
    // Only "who is asking" is read on the app pool.
    expect(new Set(calls.filter((c) => c.startsWith('app:')))).toEqual(new Set(['app:tenant.findUnique']));
    expect(calls).toContain('all:product.create');
  });
});

describe('CatalogAdminService — removing products (F-026-h)', () => {
  it('deletes a product nothing ever referenced, with its variants, and audits what it was', async () => {
    const { service, db, audit } = build();
    await expect(service.removeProducts(actor(RESELLER), [RESELLER_PRODUCT])).resolves.toEqual([{ id: RESELLER_PRODUCT, outcome: 'deleted' }]);
    expect(db.product.rows.find((r) => r['id'] === RESELLER_PRODUCT)).toBeUndefined();
    expect(db.productVariant.rows.find((r) => r['id'] === RESELLER_VARIANT)).toBeUndefined();
    expect(audit).toEqual([
      expect.objectContaining({ tenantId: RESELLER, action: 'catalog_product_delete', targetEntityId: RESELLER_PRODUCT, oldValue: expect.objectContaining({ key: 'vpn_alpha' }) }),
    ]);
  });

  it('archives a product whose variant was sold instead: kept, switched off, hidden from the list until asked for', async () => {
    const { service, db, audit } = build();
    await expect(service.removeProducts(actor(RESELLER), [SOLD_PRODUCT])).resolves.toEqual([{ id: SOLD_PRODUCT, outcome: 'archived' }]);
    const row = db.product.rows.find((r) => r['id'] === SOLD_PRODUCT);
    expect(row).toMatchObject({ isActive: false, archivedAt: expect.any(Date) });
    expect(db.productVariant.rows.find((r) => r['id'] === SOLD_VARIANT)).toBeDefined();
    expect(audit).toEqual([expect.objectContaining({ action: 'catalog_product_archive', targetEntityId: SOLD_PRODUCT })]);
    expect((await service.listProducts(actor(RESELLER))).map((p) => p.id)).not.toContain(SOLD_PRODUCT);
    expect((await service.listProducts(actor(RESELLER), { archived: true })).map((p) => p.id)).toEqual([SOLD_PRODUCT]);
  });

  it("answers each id on its own: another tenant's and the platform's are not found, and the rest still go", async () => {
    const { service, db } = build();
    await expect(service.removeProducts(actor(RESELLER), [OTHER_PRODUCT, PLATFORM_PRODUCT, RESELLER_PRODUCT, SOLD_PRODUCT])).resolves.toEqual([
      { id: OTHER_PRODUCT, outcome: 'not_found' },
      { id: PLATFORM_PRODUCT, outcome: 'not_found' },
      { id: RESELLER_PRODUCT, outcome: 'deleted' },
      { id: SOLD_PRODUCT, outcome: 'archived' },
    ]);
    expect(db.product.rows.map((r) => r['id'])).toEqual(expect.arrayContaining([OTHER_PRODUCT, PLATFORM_PRODUCT]));
  });

  it('brings an archived product back into the list, still switched off', async () => {
    const { service } = build();
    await service.removeProducts(actor(RESELLER), [SOLD_PRODUCT]);
    await expect(service.updateProduct(actor(RESELLER), SOLD_PRODUCT, { archived: false })).resolves.toMatchObject({ archivedAt: null, isActive: false });
    expect((await service.listProducts(actor(RESELLER))).map((p) => p.id)).toContain(SOLD_PRODUCT);
  });
});

describe('CatalogAdminService — removing categories (F-026-j)', () => {
  /** The reseller's two own categories: one only an archived product sits in, one empty. */
  const withCategories = () => {
    const built = build();
    built.db.productCategory.rows.push(
      { id: RESELLER_CATEGORY, tenantId: RESELLER, key: 'old', nameKey: 'catalog.t_22.category.old.name', isActive: true },
      { id: EMPTY_CATEGORY, tenantId: RESELLER, key: 'empty', nameKey: 'catalog.t_22.category.empty.name', isActive: true },
    );
    built.db.product.rows.push({ ...built.product('b0000000-0000-4000-8000-000000000005', RESELLER, 'vpn_old', RESELLER_CATEGORY), isActive: false, archivedAt: new Date('2026-09-01T00:00:00Z') });
    return built;
  };

  it('deletes a category no product sits in, and audits what it was', async () => {
    const { service, db, audit } = withCategories();
    await expect(service.removeCategories(actor(RESELLER), [EMPTY_CATEGORY])).resolves.toEqual([{ id: EMPTY_CATEGORY, outcome: 'deleted' }]);
    expect(db.productCategory.rows.find((r) => r['id'] === EMPTY_CATEGORY)).toBeUndefined();
    expect(audit).toEqual([
      expect.objectContaining({ tenantId: RESELLER, action: 'catalog_category_delete', targetEntityType: 'product_category', targetEntityId: EMPTY_CATEGORY, oldValue: expect.objectContaining({ key: 'empty' }) }),
    ]);
  });

  it('keeps a category an archived product still sits in, and writes nothing', async () => {
    const { service, db, audit } = withCategories();
    await expect(service.removeCategories(actor(RESELLER), [RESELLER_CATEGORY])).resolves.toEqual([{ id: RESELLER_CATEGORY, outcome: 'has_products' }]);
    expect(db.productCategory.rows.find((r) => r['id'] === RESELLER_CATEGORY)).toMatchObject({ isActive: true });
    expect(audit).toEqual([]);
  });

  it("answers each id on its own: another tenant's and the platform's are not found, and the rest still go", async () => {
    const { service, db } = withCategories();
    await expect(service.removeCategories(actor(RESELLER), [OTHER_CATEGORY, PLATFORM_CATEGORY, RESELLER_CATEGORY, EMPTY_CATEGORY])).resolves.toEqual([
      { id: OTHER_CATEGORY, outcome: 'not_found' },
      { id: PLATFORM_CATEGORY, outcome: 'not_found' },
      { id: RESELLER_CATEGORY, outcome: 'has_products' },
      { id: EMPTY_CATEGORY, outcome: 'deleted' },
    ]);
    expect(db.productCategory.rows.map((r) => r['id'])).toEqual([PLATFORM_CATEGORY, OTHER_CATEGORY, RESELLER_CATEGORY]);
  });

  it("lets the platform owner remove a tenant's empty category, and refuses its own shared one while products sit in it", async () => {
    const { service } = withCategories();
    await expect(service.removeCategories(actor(OWNER), [EMPTY_CATEGORY, PLATFORM_CATEGORY])).resolves.toEqual([
      { id: EMPTY_CATEGORY, outcome: 'deleted' },
      { id: PLATFORM_CATEGORY, outcome: 'has_products' },
    ]);
  });
});

describe('CatalogAdminService — removing a category with its products (F-026-l)', () => {
  const NEVER_SOLD = 'b0000000-0000-4000-8000-000000000006';
  /** The reseller's category holding one product never sold and one sold, and an empty-able one holding a never-sold product alone. */
  const withFilled = () => {
    const built = build();
    built.db.productCategory.rows.push(
      { id: RESELLER_CATEGORY, tenantId: RESELLER, key: 'old', nameKey: 'catalog.t_22.category.old.name', isActive: true },
      { id: EMPTY_CATEGORY, tenantId: RESELLER, key: 'fresh', nameKey: 'catalog.t_22.category.fresh.name', isActive: true },
    );
    for (const p of built.db.product.rows) if (p['id'] === SOLD_PRODUCT) p['categoryId'] = RESELLER_CATEGORY;
    built.db.product.rows.push(built.product(NEVER_SOLD, RESELLER, 'vpn_fresh', EMPTY_CATEGORY));
    return built;
  };

  it('archives the category when a sold product stays in it: the never-sold go, the sold are archived, and the answer counts both', async () => {
    const { service, db, audit } = withFilled();
    for (const p of db.product.rows) if (p['id'] === RESELLER_PRODUCT) p['categoryId'] = RESELLER_CATEGORY;
    await expect(service.removeCategories(actor(RESELLER), [RESELLER_CATEGORY], true)).resolves.toEqual([
      { id: RESELLER_CATEGORY, outcome: 'archived', products: { deleted: 1, archived: 1 } },
    ]);
    expect(db.productCategory.rows.find((r) => r['id'] === RESELLER_CATEGORY)).toMatchObject({ isActive: false, archivedAt: expect.any(Date) });
    expect(audit.map((a) => a['action'])).toEqual(['catalog_product_delete', 'catalog_product_archive', 'catalog_category_archive']);
    expect((await service.listCategories(actor(RESELLER))).map((c) => c.id)).not.toContain(RESELLER_CATEGORY);
    expect((await service.listCategories(actor(RESELLER), { archived: true })).map((c) => c.id)).toEqual([RESELLER_CATEGORY]);
  });

  it('deletes the category when every product in it was never sold', async () => {
    const { service, db } = withFilled();
    await expect(service.removeCategories(actor(RESELLER), [EMPTY_CATEGORY], true)).resolves.toEqual([
      { id: EMPTY_CATEGORY, outcome: 'deleted', products: { deleted: 1, archived: 0 } },
    ]);
    expect(db.productCategory.rows.find((r) => r['id'] === EMPTY_CATEGORY)).toBeUndefined();
  });

  it('without withProducts nothing inside is touched: the category is kept and answered has_products', async () => {
    const { service, db } = withFilled();
    await expect(service.removeCategories(actor(RESELLER), [EMPTY_CATEGORY])).resolves.toEqual([{ id: EMPTY_CATEGORY, outcome: 'has_products' }]);
    expect(db.product.rows.find((r) => r['id'] === NEVER_SOLD)).toBeDefined();
  });

  it("never removes another tenant's product from the platform's shared category: the owner's own go, the category stays", async () => {
    const { service, db } = withFilled();
    await expect(service.removeCategories(actor(OWNER), [PLATFORM_CATEGORY], true)).resolves.toEqual([
      { id: PLATFORM_CATEGORY, outcome: 'has_products', products: { deleted: 1, archived: 0 } },
    ]);
    expect(db.product.rows.find((r) => r['id'] === PLATFORM_PRODUCT)).toBeUndefined();
    expect(db.product.rows.find((r) => r['id'] === RESELLER_PRODUCT)).toMatchObject({ categoryId: PLATFORM_CATEGORY, isActive: true });
    expect(db.productCategory.rows.find((r) => r['id'] === PLATFORM_CATEGORY)).toMatchObject({ isActive: true });
    expect(db.productCategory.rows.find((r) => r['id'] === PLATFORM_CATEGORY)?.['archivedAt']).toBeUndefined();
  });

  it("answers another tenant's category not found and touches nothing in it", async () => {
    const { service, db } = withFilled();
    await expect(service.removeCategories(actor(RESELLER), [OTHER_CATEGORY, PLATFORM_CATEGORY], true)).resolves.toEqual([
      { id: OTHER_CATEGORY, outcome: 'not_found' },
      { id: PLATFORM_CATEGORY, outcome: 'not_found' },
    ]);
    expect(db.product.rows.map((r) => r['id'])).toEqual(expect.arrayContaining([OTHER_PRODUCT, PLATFORM_PRODUCT]));
  });

  it('files no new product in an archived category, and restoring a product in it restores the category, still switched off', async () => {
    const { service, db } = withFilled();
    await service.removeCategories(actor(RESELLER), [RESELLER_CATEGORY], true);
    expect((await refusal(() => service.createProduct(actor(RESELLER), { ...NEW_PRODUCT, categoryId: RESELLER_CATEGORY }))).reason).toBe('category_not_found');
    await service.updateProduct(actor(RESELLER), SOLD_PRODUCT, { archived: false });
    expect(db.productCategory.rows.find((r) => r['id'] === RESELLER_CATEGORY)).toMatchObject({ archivedAt: null, isActive: false });
    expect((await service.listCategories(actor(RESELLER))).map((c) => c.id)).toContain(RESELLER_CATEGORY);
  });

  it('a category already archived is answered archived again, and written once', async () => {
    const { service, audit } = withFilled();
    await service.removeCategories(actor(RESELLER), [RESELLER_CATEGORY], true);
    const before = audit.length;
    await expect(service.removeCategories(actor(RESELLER), [RESELLER_CATEGORY], true)).resolves.toEqual([
      { id: RESELLER_CATEGORY, outcome: 'archived', products: { deleted: 0, archived: 0 } },
    ]);
    expect(audit.length).toBe(before);
  });
});
