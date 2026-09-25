// A starter catalog for the platform (F-026-a, ADR-0049): the categories,
// products, variants and first prices a fresh install can sell and a reseller
// can see before writing its own. Every row is the platform's (`tenantId`
// null), so every tenant reads it (catalog invariant 4).
//
// Separate from `seed.js` on purpose: that file bootstraps what the app cannot
// run without; this is sample merchandise an operator may not want, and it is
// run by hand (`npm run seed:catalog`).
//
// Idempotent, and additive only. A category, product or SKU that already exists
// among platform rows is left exactly as it is — its price is never touched,
// because a price change is a new row with its own effectiveFrom (F-0602), an
// admin's call from /catalog, not a seed's.
//
// Money is USD decimal strings (ADR-0019, C-02). Quotas follow §4.5: bytes are
// GiB, `resetPolicy` is none | monthly | daily (`catalog-admin.schema.ts`).
// `panelGroupId` stays null until the network unit exists (F-027).
//
// Names (F-1533-d/f, ADR-0050): each item's fa and en name is published to
// locale-service's `catalog` namespace — only in a language with no text yet,
// so an admin's rename is never overwritten. A new row's source language is
// DEFAULT_LANGUAGE when that is fa or en (the two written here), else fa.
// Every other language: "Translate missing" on /catalog/translations. With
// locale-service unreachable the rows are still seeded and the names skipped.
//
// Capabilities (F-114-f-a, ADR-0086): every key a seeded product carries is a
// platform `product_capability` row, written first. A key a tenant already
// holds under a row the migration wrote (no name yet, `sourceLang` null) is
// promoted to the platform's — the tenant still sees it; one a tenant named
// itself is left alone and the key is not seeded.
const { PrismaClient } = require('@prisma/client');
const { createLocaleClient } = require('@txnet/locale-client');

const prisma = new PrismaClient();

const GIB = 1024 ** 3;
const traffic = (gib, resetPolicy = 'none') => ({ traffic_bytes: { limit: gib * GIB, resetPolicy } });
const devices = (n) => ({ concurrent_devices: { limit: n, resetPolicy: 'none' } });

const variant = (sku, price, fields) => ({
  sku,
  price,
  billingMode: 'prepaid',
  visibility: 'public',
  qualityTier: 'standard',
  durationDays: null,
  quotas: {},
  ...fields,
});

/** What a seeded product may unlock (F-114-f-a); every `featureKeys` entry below is one of these. */
const CAPABILITIES = [
  { key: 'vpn.access', name: { fa: 'دسترسی وی‌پی‌ان', en: 'VPN access' } },
  { key: 'vpn.premium_nodes', name: { fa: 'سرورهای پرمیوم', en: 'Premium servers' } },
  { key: 'vpn.dedicated_ip', name: { fa: 'آی‌پی اختصاصی', en: 'Dedicated IP' } },
  { key: 'api.public', name: { fa: 'API عمومی', en: 'Public API' } },
];

const CATALOG = [
  {
    key: 'vpn',
    name: { fa: 'وی‌پی‌ان', en: 'VPN' },
    nameKey: 'catalog.category.vpn.name',
    products: [
      {
        key: 'vpn_standard',
        name: { fa: 'وی‌پی‌ان استاندارد', en: 'Standard VPN' },
        fulfilmentKind: 'network_access',
        featureKeys: ['vpn.access'],
        defaultQuotas: { ...traffic(50), ...devices(2) },
        variants: [
          variant('VPN-STD-30D-50GB', '3.50', { durationDays: 30, quotas: { ...traffic(50), ...devices(2) } }),
          variant('VPN-STD-30D-100GB', '5.90', { durationDays: 30, quotas: { ...traffic(100), ...devices(2) } }),
          variant('VPN-STD-90D-150GB', '9.50', { durationDays: 90, quotas: { ...traffic(150), ...devices(2) } }),
          variant('VPN-STD-180D-300GB', '17.90', { durationDays: 180, quotas: { ...traffic(300), ...devices(3) } }),
        ],
      },
      {
        key: 'vpn_premium',
        name: { fa: 'وی‌پی‌ان پرمیوم', en: 'Premium VPN' },
        fulfilmentKind: 'network_access',
        featureKeys: ['vpn.access', 'vpn.premium_nodes'],
        defaultQuotas: { ...traffic(100), ...devices(3) },
        variants: [
          variant('VPN-PRM-30D-100GB', '7.90', { durationDays: 30, qualityTier: 'premium', quotas: { ...traffic(100), ...devices(3) } }),
          variant('VPN-PRM-90D-300GB', '21.00', { durationDays: 90, qualityTier: 'premium', quotas: { ...traffic(300), ...devices(3) } }),
          // A year, but the traffic comes back every month rather than all at once.
          variant('VPN-PRM-365D-150GB-MO', '74.00', { durationDays: 365, qualityTier: 'premium', quotas: { ...traffic(150, 'monthly'), ...devices(5) } }),
        ],
      },
      {
        key: 'vpn_family',
        name: { fa: 'وی‌پی‌ان خانواده', en: 'Family VPN' },
        fulfilmentKind: 'network_access',
        featureKeys: ['vpn.access', 'vpn.premium_nodes'],
        defaultQuotas: { ...traffic(250), ...devices(6) },
        variants: [
          variant('VPN-FAM-30D-250GB', '12.90', { durationDays: 30, qualityTier: 'premium', quotas: { ...traffic(250), ...devices(6) } }),
          variant('VPN-FAM-90D-750GB', '34.90', { durationDays: 90, qualityTier: 'premium', quotas: { ...traffic(750), ...devices(6) } }),
        ],
      },
      {
        // Never sold: an admin assigns it, or a free_grant coupon gives it (F-506, D-35).
        key: 'vpn_trial',
        name: { fa: 'وی‌پی‌ان آزمایشی', en: 'VPN Trial' },
        fulfilmentKind: 'network_access',
        featureKeys: ['vpn.access'],
        defaultQuotas: { ...traffic(1), ...devices(1) },
        variants: [
          variant('VPN-TRIAL-1D-1GB', '0.00', { durationDays: 1, visibility: 'admin_only', quotas: { ...traffic(1), ...devices(1) } }),
          variant('VPN-TRIAL-3D-3GB', '0.00', { durationDays: 3, visibility: 'admin_only', quotas: { ...traffic(3), ...devices(1) } }),
        ],
      },
    ],
  },
  {
    key: 'vpn_addons',
    name: { fa: 'افزونه‌های وی‌پی‌ان', en: 'VPN Add-ons' },
    nameKey: 'catalog.category.vpn_addons.name',
    products: [
      {
        key: 'dedicated_ip',
        name: { fa: 'آی‌پی اختصاصی', en: 'Dedicated IP' },
        fulfilmentKind: 'feature_access',
        featureKeys: ['vpn.dedicated_ip'],
        defaultQuotas: {},
        variants: [
          variant('ADDON-DIP-30D', '4.00', { durationDays: 30 }),
          variant('ADDON-DIP-90D', '10.50', { durationDays: 90 }),
        ],
      },
      {
        key: 'extra_traffic',
        name: { fa: 'ترافیک اضافه', en: 'Extra Traffic' },
        fulfilmentKind: 'network_access',
        featureKeys: ['vpn.access'],
        defaultQuotas: traffic(50),
        // Sold by a direct link from the "traffic running out" notice, not listed.
        variants: [
          variant('ADDON-TRF-50GB', '2.50', { durationDays: 30, visibility: 'unlisted', quotas: traffic(50) }),
          variant('ADDON-TRF-200GB', '8.90', { durationDays: 30, visibility: 'unlisted', quotas: traffic(200) }),
        ],
      },
    ],
  },
  {
    key: 'developer_api',
    name: { fa: 'API توسعه‌دهندگان', en: 'Developer API' },
    nameKey: 'catalog.category.developer_api.name',
    products: [
      {
        key: 'api_access',
        name: { fa: 'دسترسی API', en: 'API Access' },
        fulfilmentKind: 'feature_access',
        featureKeys: ['api.public'],
        defaultQuotas: { api_calls: { limit: 100000, resetPolicy: 'monthly' } },
        variants: [
          variant('API-STARTER-30D', '15.00', { durationDays: 30, quotas: { api_calls: { limit: 100000, resetPolicy: 'monthly' } } }),
          variant('API-PRO-30D', '49.00', { durationDays: 30, quotas: { api_calls: { limit: 1000000, resetPolicy: 'monthly' } } }),
          variant('API-BIZ-365D', '490.00', { durationDays: 365, quotas: { api_calls: { limit: 5000000, resetPolicy: 'monthly' } } }),
        ],
      },
    ],
  },
  {
    key: 'social_growth',
    name: { fa: 'رشد شبکه‌های اجتماعی', en: 'Social Growth' },
    nameKey: 'catalog.category.social_growth.name',
    products: [
      {
        key: 'instagram_followers',
        name: { fa: 'فالوور اینستاگرام', en: 'Instagram Followers' },
        fulfilmentKind: 'external_order',
        featureKeys: [],
        defaultQuotas: { order_units: { limit: 1000, resetPolicy: 'none' } },
        variants: [
          variant('IG-FOLLOW-1K', '2.50', { quotas: { order_units: { limit: 1000, resetPolicy: 'none' } } }),
          variant('IG-FOLLOW-5K', '11.00', { quotas: { order_units: { limit: 5000, resetPolicy: 'none' } } }),
          variant('IG-FOLLOW-10K', '19.90', { quotas: { order_units: { limit: 10000, resetPolicy: 'none' } } }),
        ],
      },
      {
        key: 'telegram_members',
        name: { fa: 'ممبر تلگرام', en: 'Telegram Members' },
        fulfilmentKind: 'external_order',
        featureKeys: [],
        defaultQuotas: { order_units: { limit: 1000, resetPolicy: 'none' } },
        variants: [
          variant('TG-MEMBER-1K', '3.20', { quotas: { order_units: { limit: 1000, resetPolicy: 'none' } } }),
          variant('TG-MEMBER-5K', '14.50', { quotas: { order_units: { limit: 5000, resetPolicy: 'none' } } }),
        ],
      },
    ],
  },
];

const counts = { capabilities: 0, categories: 0, products: 0, variants: 0 };

const SOURCE_LANG = ['fa', 'en'].includes(process.env.DEFAULT_LANGUAGE) ? process.env.DEFAULT_LANGUAGE : 'fa';
/** Platform rows' keys: `catalog.<kind>.<key>.name` (billing's `catalogTextKey`, no tenant prefix). */
const nameKeyOf = (kind, key) => `catalog.${kind}.${key}.name`;
/** fa/en name per full key, published at the end. */
const names = new Map();

/** The platform's row for a capability key, or null when a tenant named its own and it was left alone. */
async function ensureCapability({ key, name }) {
  const nameKey = nameKeyOf('capability', key);
  const found = await prisma.productCapability.findFirst({ where: { tenantId: null, key } });
  if (found) {
    names.set(nameKey, name);
    return found;
  }
  const held = await prisma.productCapability.findMany({ where: { key, tenantId: { not: null } } });
  if (held.some((c) => c.sourceLang !== null)) {
    console.warn(`[seed-catalog] capability ${key} is a tenant's own, named by it: not seeded, and no seeded product carries it.`);
    return null;
  }
  names.set(nameKey, name);
  counts.capabilities++;
  // The migration's unnamed tenant rows give way to the platform's, in one transaction: the tenant sees it either way.
  const [, created] = await prisma.$transaction([
    prisma.productCapability.deleteMany({ where: { key, tenantId: { not: null }, sourceLang: null } }),
    prisma.productCapability.create({ data: { tenantId: null, key, nameKey, sourceLang: SOURCE_LANG } }),
  ]);
  return created;
}

async function ensureCategory({ key, name }) {
  const nameKey = nameKeyOf('category', key);
  names.set(nameKey, name);
  const found = await prisma.productCategory.findFirst({ where: { tenantId: null, key } });
  if (found) return found;
  counts.categories++;
  return prisma.productCategory.create({ data: { tenantId: null, key, nameKey, sourceLang: SOURCE_LANG } });
}

async function ensureProduct(categoryId, p, capabilities) {
  names.set(nameKeyOf('product', p.key), p.name);
  const found = await prisma.product.findFirst({ where: { tenantId: null, key: p.key } });
  if (found) return found;
  counts.products++;
  return prisma.product.create({
    data: {
      tenantId: null,
      key: p.key,
      nameKey: nameKeyOf('product', p.key),
      // No description text is seeded, so no key that would show as one.
      descriptionKey: null,
      sourceLang: SOURCE_LANG,
      fulfilmentKind: p.fulfilmentKind,
      featureKeys: p.featureKeys.filter((k) => capabilities.has(k)),
      defaultQuotas: p.defaultQuotas,
      // Filed in its category, first (F-026-q: a product's categories are links).
      categories: { create: { categoryId, tenantId: null, position: 0 } },
    },
  });
}

async function ensureVariant(productId, v, at) {
  const found = await prisma.productVariant.findFirst({ where: { tenantId: null, sku: v.sku } });
  if (found) return;
  counts.variants++;
  const { price, ...fields } = v;
  // Written with its first price, as the admin API does (F-026-d).
  await prisma.productVariant.create({
    data: {
      tenantId: null,
      productId,
      ...fields,
      prices: { create: { tenantId: null, amount: price, effectiveFrom: at } },
    },
  });
}

async function main() {
  const at = new Date();
  const capabilities = new Set();
  for (const c of CAPABILITIES) if (await ensureCapability(c)) capabilities.add(c.key);
  for (const c of CATALOG) {
    const category = await ensureCategory(c);
    for (const p of c.products) {
      const product = await ensureProduct(category.id, p, capabilities);
      for (const v of p.variants) await ensureVariant(product.id, v, at);
    }
  }
  await publishNames();
  console.log(
    `[seed-catalog] added ${counts.capabilities} capabilities, ${counts.categories} categories, ${counts.products} products, ${counts.variants} variants (existing rows left as they were).`,
  );
}

/** Publishes each name in fa and en where that language has no text yet. */
async function publishNames() {
  const client = createLocaleClient({
    addr: process.env.LOCALE_SERVICE_ADDR || 'localhost:50051',
    scope: 'backend',
    bootTimeoutMs: 5_000,
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await client.ready();
    for (const lang of ['fa', 'en']) {
      const published = client.namespace(lang, 'catalog') ?? {};
      const entries = {};
      for (const [key, name] of names) {
        const entry = key.slice('catalog.'.length);
        if (!published[entry]) entries[entry] = name[lang];
      }
      if (Object.keys(entries).length) {
        await client.setEntries({ scope: 'shareds', lang, namespace: 'catalog', entries });
        console.log(`[seed-catalog] ${lang}: published ${Object.keys(entries).length} names.`);
      }
    }
  } catch (e) {
    console.warn(`[seed-catalog] names skipped, locale-service unavailable: ${String(e)}`);
  } finally {
    client.close();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
