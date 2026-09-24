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
 *  - **names are the server's keys** (F-1533-d): a tenant's item is named under
 *    its own `t_<tenant>.` prefix, and a translation is reviewed only by
 *    whoever manages the item it names — the rules of the text itself are
 *    `catalog-texts.spec.ts`.
 *
 * What the database holds for every writer is `catalog-schema.int.spec.ts`.
 */
import { FulfilmentKind, Prisma, TenantType, VariantBillingMode, VariantVisibility } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { CatalogAdminRefused, CatalogAdminService } from './catalog-admin.service';
import { CatalogTextService, catalogTextKey } from './catalog-texts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PLATFORM_CATEGORY = 'a0000000-0000-4000-8000-000000000001';
const OTHER_CATEGORY = 'a0000000-0000-4000-8000-000000000003';
const PLATFORM_PRODUCT = 'b0000000-0000-4000-8000-000000000001';
const RESELLER_PRODUCT = 'b0000000-0000-4000-8000-000000000002';
const OTHER_PRODUCT = 'b0000000-0000-4000-8000-000000000003';
const RESELLER_VARIANT = 'c0000000-0000-4000-8000-000000000002';
const RESELLER_PRICE = 'd0000000-0000-4000-8000-000000000002';
const PLATFORM_GROUP = 'f0000000-0000-4000-8000-000000000001';
const RESELLER_GROUP = 'f0000000-0000-4000-8000-000000000002';
const OTHER_GROUP = 'f0000000-0000-4000-8000-000000000003';

const actor = (tenantId: string) => ({ adminId: ADMIN, tenantId, ip: '10.0.0.9' });

type Row = Record<string, unknown>;

const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([k, v]) => v === undefined || (row[k] ?? null) === v);

const unique = (message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code: 'P2002', clientVersion: 'test' });

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

function table(rows: Row[], name: string, writes: string[], uniqueOn: string[] = []) {
  let next = 0;
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
    ),
    product: table(
      [product(PLATFORM_PRODUCT, null, 'vpn_basic'), product(RESELLER_PRODUCT, RESELLER, 'vpn_alpha'), product(OTHER_PRODUCT, OTHER, 'followers_1k', OTHER_CATEGORY)],
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
      ],
      'productVariant',
      writes,
      ['tenantId', 'sku'],
    ),
    panelGroup: table(
      [
        { id: PLATFORM_GROUP, tenantId: null },
        { id: RESELLER_GROUP, tenantId: RESELLER },
        { id: OTHER_GROUP, tenantId: OTHER },
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
  return { service: inTenant(new CatalogAdminService(app as never, all as never, textService as unknown as CatalogTextService)), db, writes, audit, texts, calls };
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
    ]);
    // 2 categories + 3 products × (name, description)
    expect(await service.listTextDrafts(actor(OWNER))).toHaveLength(8);
    await expect(service.draftMissingTexts(actor(RESELLER))).resolves.toEqual({ drafted: 2 });
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
