import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Me } from "@/lib/auth-api";
import type { CatalogCapability, CatalogPrice, CatalogRateCard, PanelGroupOption } from "@/lib/catalog-api";
import { PANEL_CATALOG } from "@/lib/routes";
import { PANEL_MENU, isMenuGroup } from "../_lib/panel-menu";
import {
  BILLING_MODES,
  CATALOG_KEYS,
  CATALOG_MANAGE,
  CREATABLE_FULFILMENT_KINDS,
  FULFILMENT_KINDS,
  RETIRED_FULFILMENT_KINDS,
  QUALITY_TIERS,
  QUOTA_METRICS,
  REFUSAL_KEYS,
  RESET_POLICIES,
  VISIBILITIES,
  CATEGORY_MAX_DEPTH,
  categoryPath,
  categoryTree,
  moveBody,
  parentChoices,
  catalogText,
  categoryBody,
  currentPrice,
  emptyCategoryForm,
  emptyProductForm,
  flattenTexts,
  editId,
  namesBody,
  removalReport,
  categoryRemovalReport,
  RESTORE_CATEGORY,
  heldByProducts,
  mergeRemovals,
  productCounts,
  switchReport,
  switchTargets,
  reviewWrites,
  stillSelected,
  validateCategoryForm,
  validateNamesForm,
  emptyVariantForm,
  priceBody,
  productBody,
  validatePriceForm,
  validateProductForm,
  validateVariantForm,
  afterWizard,
  wizardCategoryBody,
  variantBody,
  emptyWizard,
  capabilitiesFor,
  capabilityBody,
  canEditCapability,
  emptyCapabilityForm,
  suggestCapabilityKey,
  validateCapabilityForm,
  firstInvalidStep,
  isFeatureKey,
  slugKey,
  suggestKey,
  suggestSku,
  wizardStepErrors,
  WIZARD_STEPS,
  quotaFromInput,
  quotaToInput,
  groupsForVariant,
  notForSale,
  panelGroupPatch,
  takesPanelGroup,
  wizardVariantTenant,
  RATE_CARD_MODES,
  currentRateCard,
  noRate,
  rateCardBody,
  rateDecimals,
  validateRateCardForm,
} from "./_lib/catalog-form";

/**
 * The catalog page (F-026-f, D-34). What breaks without a browser to see it:
 *  - **a refusal with no sentence, or a choice billing refuses.** Every reason
 *    `CatalogAdminService` can send has a line, and every select offers exactly
 *    the Prisma enum or schema tuple it is sent to — both read out of their
 *    own source;
 *  - **the form sending what billing refuses** — a key or SKU of the wrong shape,
 *    a negative price, a duration of zero, a quota that is not a whole number;
 *  - **a price that reprices an issued invoice.** A new price never starts on a
 *    day already begun: today means "from now", a later day starts at its
 *    first instant in Tehran, an earlier day is refused here as billing would;
 *  - **the wrong "current" price** shown beside the history — the rule is
 *    billing's `priceAt`: the newest active row already in effect;
 *  - **the menu entry** shown without `catalog.manage`;
 *  - **a name that is not what billing takes** (F-1533-d/g): text in the
 *    item's source language (default `DEFAULT_LANGUAGE`), never a key;
 *  - **a list showing a raw key** where a name exists: the requested language,
 *    then the item's source language (ADR-0050 amendment 2).
 */
const REPO = join(__dirname, "../../../../..");
const BACKEND = join(REPO, "txnet-backend");
const read = (path: string) => readFileSync(join(BACKEND, path), "utf8");
const LOCALES = join(REPO, "locales/frontend/langs");

function unionOf(file: string, name: string): string[] {
  const union = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(read(file));
  if (!union) throw new Error(`${name} is no longer a literal union — this test is stale`);
  return [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

function enumOf(file: string, name: string): string[] {
  const body = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(read(file));
  if (!body) throw new Error(`enum ${name} is gone — this test is stale`);
  return body[1].split("\n").map((l) => l.trim()).filter((l) => /^[a-z_]+$/.test(l));
}

function tupleOf(file: string, name: string): string[] {
  const tuple = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(read(file));
  if (!tuple) throw new Error(`${name} is no longer an as-const tuple — this test is stale`);
  return [...tuple[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const OWNER: Me = {
  userId: "u1",
  fullName: "Theora",
  role: { id: "r1", name: "SuperAdmin" },
  permissions: ["*"],
  tenant: { id: "t-owner", type: "platform_owner", isOwner: false },
  email: null,
  isImpersonated: false,
};
const RESELLER: Me = { ...OWNER, role: { id: "r2", name: "Admin" }, permissions: ["catalog.manage"], tenant: { id: "t-res", type: "reseller", isOwner: false } };
const UUID = "22222222-2222-4222-8222-222222222222";

describe("what billing can refuse, and what it accepts", () => {
  it("has a sentence for every reason", () => {
    expect(Object.keys(REFUSAL_KEYS).sort()).toEqual(unionOf("billing-service/src/app/catalog/catalog-admin.service.ts", "CatalogAdminRejection").sort());
  });

  it.each([
    ["VariantVisibility", "prisma/domains/catalog.prisma", VISIBILITIES],
    ["VariantBillingMode", "prisma/domains/catalog.prisma", BILLING_MODES],
    ["FulfilmentKind", "prisma/domains/catalog.prisma", FULFILMENT_KINDS],
    ["QualityTier", "prisma/domains/catalog.prisma", QUALITY_TIERS],
    ["QuotaMetric", "prisma/domains/entitlement.prisma", QUOTA_METRICS],
    ["RateCardMode", "prisma/domains/catalog.prisma", RATE_CARD_MODES],
  ])("offers exactly the %s enum", (name, file, offered) => {
    expect([...offered].sort()).toEqual(enumOf(file, name).sort());
  });

  it("never offers a kind billing retired (F-111-g, F-111-h)", () => {
    expect([...RETIRED_FULFILMENT_KINDS]).toEqual(tupleOf("billing-service/src/app/catalog/catalog-admin.schema.ts", "RETIRED_FULFILMENT_KINDS"));
    expect(CREATABLE_FULFILMENT_KINDS).not.toContain("wallet_topup");
    expect(CREATABLE_FULFILMENT_KINDS).not.toContain("external_order");
    expect(CREATABLE_FULFILMENT_KINDS.length + RETIRED_FULFILMENT_KINDS.length).toBe(FULFILMENT_KINDS.length);
  });

  it("offers exactly the schema's reset policies", () => {
    expect([...RESET_POLICIES].sort()).toEqual(tupleOf("billing-service/src/app/catalog/catalog-admin.schema.ts", "RESET_POLICIES").sort());
  });
});

describe("the product form", () => {
  const valid = () => ({ ...emptyProductForm("fa"), categoryIds: [UUID], key: "vpn_pro", name: "وی‌پی‌ان پرو", featureKeys: ["vpn.access"] });

  it("accepts a plain product", () => {
    expect(validateProductForm(valid(), RESELLER)).toEqual({});
  });

  it.each([
    [{ key: "Bad Key" }, "key"],
    [{ name: "  " }, "name"],
    [{ sourceLang: "" }, "sourceLang"],
    [{ featureKeys: ["vpn.access", "Not-A-Key"] }, "featureKeys"],
    [{ categoryIds: [] }, "categoryIds"],
  ])("refuses %o on %s", (patch, field) => {
    expect(validateProductForm({ ...valid(), ...patch }, RESELLER)).toHaveProperty(field);
  });

  it("asks the platform owner for a tenant id when the product is another tenant's, and never a reseller", () => {
    expect(validateProductForm({ ...valid(), owner: "tenant", tenantId: "x" }, OWNER)).toHaveProperty("tenantId");
    expect(validateProductForm({ ...valid(), owner: "tenant", tenantId: "x" }, RESELLER)).toEqual({});
  });

  it("sends a reseller's product with no tenant, and names the owner's choice", () => {
    expect(productBody(valid(), RESELLER)).not.toHaveProperty("tenantId");
    expect(productBody({ ...valid(), owner: "platform" }, OWNER)).toMatchObject({ tenantId: null });
    expect(productBody({ ...valid(), owner: "tenant", tenantId: UUID }, OWNER)).toMatchObject({ tenantId: UUID });
    expect(productBody({ ...valid(), owner: "own" }, OWNER)).not.toHaveProperty("tenantId");
  });

  it("files a product in every category picked, in the order picked, and asks for translations only when ticked (F-026-s)", () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    const body = productBody({ ...valid(), categoryIds: [OTHER, UUID, OTHER] }, RESELLER);
    expect(body.categoryIds).toEqual([OTHER, UUID]);
    expect(body).not.toHaveProperty("translateAll");
    expect(emptyProductForm("fa").translateAll).toBe(false);
    expect(productBody({ ...valid(), translateAll: true }, RESELLER)).toMatchObject({ translateAll: true });
  });

  it("trims feature keys and drops repeats, and leaves out a blank description", () => {
    const body = productBody({ ...valid(), featureKeys: [" vpn.access", "api.public", "vpn.access "] }, RESELLER);
    expect(body.featureKeys).toEqual(["vpn.access", "api.public"]);
    expect(body).not.toHaveProperty("description");
  });

  it("starts in the deployment's language, and sends text in the source language picked, never a key", () => {
    expect(emptyProductForm("de").sourceLang).toBe("de");
    const body = productBody({ ...valid(), sourceLang: "en", name: "  VPN Pro ", description: "About" }, RESELLER);
    expect(body).toMatchObject({ sourceLang: "en", name: { en: "VPN Pro" }, description: { en: "About" } });
    expect(body).not.toHaveProperty("nameKey");
    expect(body).not.toHaveProperty("descriptionKey");
  });
});

describe("nothing to remember: keys and capabilities are suggested", () => {
  it("knows billing's feature-key shape", () => {
    expect(isFeatureKey("vpn.access")).toBe(true);
    expect(isFeatureKey("vpn")).toBe(false);
    expect(isFeatureKey("VPN.Access")).toBe(false);
  });

  it("derives a key billing accepts from a name in any script", () => {
    expect(slugKey("VPN Pro 90 Days!")).toBe("vpn_pro_90_days");
    expect(slugKey("وی‌پی‌ان ویژه")).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
    expect(slugKey("۳۰ روزه")).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
    expect(slugKey("   ")).toBe("");
    expect(slugKey("x".repeat(100))).toHaveLength(64);
  });

  it("never suggests a key already taken, and falls back when the name gives nothing", () => {
    expect(suggestKey("VPN Pro", ["vpn_pro", "vpn_pro_2"], "product")).toBe("vpn_pro_3");
    expect(suggestKey("!!!", [], "product")).toMatch(/^product_[a-z0-9]+$/);
  });

  it("suggests a SKU from the product key and the duration", () => {
    expect(suggestSku("vpn_pro", "30")).toBe("VPN_PRO-30D");
    expect(suggestSku("vpn_pro", "")).toBe("VPN_PRO-PERM");
    expect(suggestSku("a".repeat(64), "365")).toMatch(/^[A-Z0-9][A-Z0-9_-]{1,39}$/);
  });
});

describe("capabilities are picked from billing's list, by name (F-114-f-b, ADR-0086)", () => {
  const cap = (key: string, tenantId: string | null): CatalogCapability => ({
    id: `id-${key}`,
    tenantId,
    key,
    nameKey: `catalog.capability.${key}.name`,
    descriptionKey: null,
    sourceLang: "fa",
  });
  const list = [cap("vpn.access", null), cap("feature.gold", "t-res"), cap("feature.other", "t-x")];

  it("offers a product the platform's capabilities and its own tenant's, never another tenant's", () => {
    expect(capabilitiesFor(list, "t-res").map((c) => c.key)).toEqual(["vpn.access", "feature.gold"]);
    expect(capabilitiesFor(list, null).map((c) => c.key)).toEqual(["vpn.access"]);
    // Not the platform owner: billing already narrowed the list.
    expect(capabilitiesFor(list, undefined)).toHaveLength(3);
  });

  it("derives a dotted key from the name, past every key the list already holds", () => {
    expect(suggestCapabilityKey("Premium nodes", [])).toBe("feature.premium_nodes");
    expect(suggestCapabilityKey("Premium nodes", ["feature.premium_nodes", "feature.premium_nodes_2"])).toBe("feature.premium_nodes_3");
    expect(isFeatureKey(suggestCapabilityKey("سرور ویژه", []))).toBe(true);
    expect(isFeatureKey(suggestCapabilityKey("!!!", []))).toBe(true);
  });

  it("asks a name and a key in billing's shape, and sends text, never a name key", () => {
    const valid = { ...emptyCapabilityForm("fa"), key: "feature.gold", name: "طلایی" };
    expect(validateCapabilityForm(valid)).toEqual({});
    expect(validateCapabilityForm({ ...valid, key: "gold" })).toHaveProperty("key");
    expect(validateCapabilityForm({ ...valid, name: " " })).toHaveProperty("name");
    const body = capabilityBody({ ...valid, name: " طلایی " }, undefined);
    expect(body).toEqual({ key: "feature.gold", sourceLang: "fa", name: { fa: "طلایی" } });
    expect(capabilityBody({ ...valid, translateAll: true }, undefined)).toMatchObject({ translateAll: true });
  });

  it("files a new capability under the tenant named, and leaves it to billing when none is", () => {
    const valid = { ...emptyCapabilityForm("fa"), key: "feature.gold", name: "طلایی" };
    expect(capabilityBody(valid, null)).toMatchObject({ tenantId: null });
    expect(capabilityBody(valid, UUID)).toMatchObject({ tenantId: UUID });
    expect(capabilityBody(valid, undefined)).not.toHaveProperty("tenantId");
  });

  it("lets the platform owner edit every capability, and a tenant only its own", () => {
    expect(canEditCapability(cap("vpn.access", null), true)).toBe(true);
    expect(canEditCapability(cap("vpn.access", null), false)).toBe(false);
    expect(canEditCapability(cap("feature.gold", "t-res"), false)).toBe(true);
  });
});

describe("the new product wizard", () => {
  const ready = () => {
    const w = emptyWizard("fa");
    w.categoryIds = [UUID];
    w.product = { ...w.product, key: "vpn_pro", name: "وی‌پی‌ان پرو", featureKeys: ["vpn.access"] };
    w.variant = { ...w.variant, sku: "VPN_PRO-30D", price: "5", durationDays: "30" };
    return w;
  };

  it("walks category, names, access, first variant, review", () => {
    expect(WIZARD_STEPS).toEqual(["category", "names", "access", "variant", "review"]);
    expect(firstInvalidStep(ready(), RESELLER)).toBeNull();
  });

  it("checks each step only for its own fields", () => {
    const w = ready();
    w.product.name = "";
    expect(wizardStepErrors("category", w, RESELLER)).toEqual({});
    expect(wizardStepErrors("names", w, RESELLER)).toHaveProperty("name");
    expect(firstInvalidStep(w, RESELLER)).toBe("names");
  });

  it("needs a picked category, or a new one with a name", () => {
    const w = ready();
    w.categoryIds = [];
    expect(wizardStepErrors("category", w, RESELLER)).toHaveProperty("categoryIds");
    w.newCategory = { ...w.newCategory, key: "vpn", name: "" };
    w.categoryMode = "new";
    expect(wizardStepErrors("category", w, RESELLER)).toHaveProperty("name");
    w.newCategory.name = "وی‌پی‌ان";
    expect(wizardStepErrors("category", w, RESELLER)).toEqual({});
  });

  it("files a new category under the product's owner, whatever the shared box says", () => {
    const w = ready();
    w.categoryMode = "new";
    w.newCategory = { ...w.newCategory, key: "vpn", name: "وی‌پی‌ان" };
    // The platform owner's platform product: the category must be the platform's too.
    w.product.owner = "platform";
    expect(wizardCategoryBody(w, OWNER)).toMatchObject({ tenantId: null });
    w.product = { ...w.product, owner: "tenant", tenantId: UUID };
    expect(wizardCategoryBody(w, OWNER)).toMatchObject({ tenantId: UUID });
    w.product.owner = "own";
    expect(wizardCategoryBody(w, OWNER)).not.toHaveProperty("tenantId");
    expect(wizardCategoryBody({ ...w, newCategory: { ...w.newCategory, shared: true } }, OWNER)).toMatchObject({ tenantId: null });
    // Nobody else chooses: billing files a reseller's category under the reseller.
    expect(wizardCategoryBody({ ...w, product: { ...w.product, owner: "platform" } }, RESELLER)).not.toHaveProperty("tenantId");
  });

  it("refuses an existing category the product's owner cannot file in, before anything is sent", () => {
    const w = ready();
    const cats = [
      { id: UUID, tenantId: "t-owner" },
      { id: "shared", tenantId: null },
    ];
    w.product.owner = "platform";
    expect(wizardStepErrors("category", w, OWNER, cats)).toHaveProperty("categoryIds", CATALOG_KEYS.wizard.categoryNotForOwner);
    w.categoryIds = ["shared"];
    expect(wizardStepErrors("category", w, OWNER, cats)).toEqual({});
    w.categoryIds = [UUID];
    w.product.owner = "own";
    expect(wizardStepErrors("category", w, OWNER, cats)).toEqual({});
    expect(firstInvalidStep({ ...w, product: { ...w.product, owner: "platform" } }, OWNER, cats)).toBe("category");
  });

  it("lets the first variant be skipped, and checks it only when it is not", () => {
    const w = ready();
    w.variant.price = "";
    expect(wizardStepErrors("variant", w, RESELLER)).toHaveProperty("price");
    w.withVariant = false;
    expect(wizardStepErrors("variant", w, RESELLER)).toEqual({});
  });

  it("lands on the list with the new product marked, and opens it only when a variant is still to add (F-114-g)", () => {
    expect(afterWizard("p1", false)).toEqual({ openId: null, freshId: "p1", notice: CATALOG_KEYS.wizard.done, error: null });
    expect(afterWizard("p1", true)).toEqual({ openId: "p1", freshId: "p1", notice: null, error: CATALOG_KEYS.wizard.partial });
  });
});

describe("the category form and renaming", () => {
  it("needs a key and a name in its source language, and shares only the owner's category when asked", () => {
    const valid = { ...emptyCategoryForm("fa"), key: "games", name: "بازی" };
    expect(validateCategoryForm(valid)).toEqual({});
    expect(validateCategoryForm({ ...valid, name: " " })).toHaveProperty("name");
    expect(validateCategoryForm({ ...valid, key: "Games" })).toHaveProperty("key");
    expect(categoryBody({ ...valid, shared: true }, true)).toEqual({ key: "games", sourceLang: "fa", name: { fa: "بازی" }, tenantId: null });
    expect(categoryBody({ ...valid, shared: true }, false)).toEqual({ key: "games", sourceLang: "fa", name: { fa: "بازی" } });
  });

  it("files a new category under the parent picked, and asks for translations only when ticked (F-026-s)", () => {
    const valid = { ...emptyCategoryForm("fa"), key: "games", name: "بازی" };
    expect(emptyCategoryForm("fa")).toMatchObject({ parentId: "", translateAll: false });
    expect(categoryBody({ ...valid, parentId: UUID }, false)).toEqual({ key: "games", sourceLang: "fa", name: { fa: "بازی" }, parentId: UUID });
    expect(categoryBody({ ...valid, translateAll: true }, false)).toMatchObject({ translateAll: true });
  });

  it("renames in the source language picked, and clears a description left blank", () => {
    const names = { sourceLang: "en", name: "Alpha", description: "", translateAll: false };
    expect(validateNamesForm(names)).toEqual({});
    expect(namesBody(names, "product")).toEqual({ sourceLang: "en", name: { en: "Alpha" }, description: null });
    expect(namesBody({ ...names, description: " About " }, "product")).toEqual({ sourceLang: "en", name: { en: "Alpha" }, description: { en: "About" } });
    expect(namesBody(names, "category")).toEqual({ sourceLang: "en", name: { en: "Alpha" } });
    expect(validateNamesForm({ ...names, name: "" })).toHaveProperty("name");
    expect(namesBody({ ...names, translateAll: true }, "category")).toEqual({ sourceLang: "en", name: { en: "Alpha" }, translateAll: true });
  });
});

describe("names in the list", () => {
  const texts = {
    fa: flattenTexts({ product: { vpn: { name: "وی‌پی‌ان" }, only_fa: { name: "فقط فارسی" } } }),
    en: flattenTexts({ product: { vpn: { name: "VPN" } }, t_22222222222242228222222222222222: { product: { vpn: { name: "My VPN" } } } }),
    de: flattenTexts({ product: { de_only: { name: "Nur Deutsch" } } }),
  };

  it("flattens the i18n route's nested answer back to full keys", () => {
    expect(texts.en).toEqual({ "catalog.product.vpn.name": "VPN", "catalog.t_22222222222242228222222222222222.product.vpn.name": "My VPN" });
  });

  it("reads the asked language, then the item's source language, then nothing — never another language", () => {
    expect(catalogText(texts, "de", "catalog.product.de_only.name", "fa")).toBe("Nur Deutsch");
    expect(catalogText(texts, "de", "catalog.product.vpn.name", "en")).toBe("VPN");
    expect(catalogText(texts, "de", "catalog.product.vpn.name", "fa")).toBe("وی‌پی‌ان");
    expect(catalogText(texts, "en", "catalog.product.only_fa.name", "de")).toBeNull();
    expect(catalogText(texts, "fa", null, "fa")).toBeNull();
  });
});

describe("the variant form", () => {
  const valid = () => ({
    ...emptyVariantForm(),
    sku: "vpn-90",
    price: "12.5",
    durationDays: "90",
    quotas: [{ metric: "traffic_bytes" as const, limit: "53687091200", resetPolicy: "none" as const }],
  });

  it("accepts a plain variant and sends the SKU upper-cased with its quotas by metric", () => {
    expect(validateVariantForm(valid())).toEqual({});
    expect(variantBody(valid(), "network_access")).toEqual({
      sku: "VPN-90",
      billingMode: "prepaid",
      visibility: "public",
      qualityTier: "standard",
      durationDays: 90,
      price: "12.5",
      quotas: { traffic_bytes: { limit: 53687091200, resetPolicy: "none" } },
    });
  });

  it("sends a blank duration as permanent", () => {
    expect(variantBody({ ...valid(), durationDays: "" }, "feature_access")).toMatchObject({ durationDays: null });
  });

  it.each([
    [{ sku: "bad sku!" }, "sku"],
    [{ price: "" }, "price"],
    [{ price: "-1" }, "price"],
    [{ price: "1.234" }, "price"],
    [{ durationDays: "0" }, "durationDays"],
    [{ durationDays: "3651" }, "durationDays"],
    [{ quotas: [{ metric: "traffic_bytes" as const, limit: "lots", resetPolicy: "none" as const }] }, "quotas"],
    [
      {
        quotas: [
          { metric: "api_calls" as const, limit: "10", resetPolicy: "daily" as const },
          { metric: "api_calls" as const, limit: "20", resetPolicy: "monthly" as const },
        ],
      },
      "quotas",
    ],
  ])("refuses %o on %s", (patch, field) => {
    expect(validateVariantForm({ ...valid(), ...patch })).toHaveProperty(field);
  });

  it("takes traffic in whole GB and stores bytes; every other metric as typed", () => {
    expect(quotaFromInput("traffic_bytes", "50")).toBe("53687091200");
    expect(quotaToInput("traffic_bytes", "53687091200")).toBe("50");
    expect(quotaFromInput("traffic_bytes", "5.5")).toBe("5.5"); // left for the validator to refuse
    expect(quotaFromInput("concurrent_devices", "2")).toBe("2");
    expect(quotaToInput("traffic_bytes", "")).toBe("");
  });

  it("allows a free variant", () => {
    expect(validateVariantForm({ ...valid(), price: "0" })).toEqual({});
  });
});

describe("a variant's panel group (F-026-o)", () => {
  const group = (id: string, tenantId: string | null): PanelGroupOption => ({ id, tenantId, name: id, strategy: "mirror", protocols: ["vless"], healthyMembers: 1 });
  const groups = [group("platform-eu", null), group("owner-own", "t-owner"), group("res-a", "t-res"), group("res-b", "t-other")];
  const form = () => ({ ...emptyVariantForm(), sku: "VPN-30", price: "5", durationDays: "30" });

  it("is asked only of a network_access variant — nothing else is placed on a panel", () => {
    expect(FULFILMENT_KINDS.filter(takesPanelGroup)).toEqual(["network_access"]);
  });

  it("offers a variant the platform's groups and its own tenant's, as billing's usableGroup admits", () => {
    expect(groupsForVariant(groups, "t-res").map((g) => g.id)).toEqual(["platform-eu", "res-a"]);
    expect(groupsForVariant(groups, null).map((g) => g.id)).toEqual(["platform-eu"]);
    // A tenant's own list, or a reseller's screen: billing already narrowed it.
    expect(groupsForVariant(groups, undefined)).toEqual(groups);
  });

  it("knows the wizard's variant tenant from the owner's choice; anyone else's is billing's to narrow", () => {
    const p = emptyProductForm("en");
    expect(wizardVariantTenant({ ...p, owner: "platform" }, OWNER)).toBeNull();
    expect(wizardVariantTenant({ ...p, owner: "own" }, OWNER)).toBe("t-owner");
    expect(wizardVariantTenant({ ...p, owner: "tenant", tenantId: " t-res " }, OWNER)).toBe("t-res");
    expect(wizardVariantTenant({ ...p, owner: "platform" }, RESELLER)).toBeUndefined();
    expect(wizardVariantTenant(p, null)).toBeUndefined();
  });

  it("sends the group on a network_access variant only, and none when none is picked", () => {
    expect(variantBody({ ...form(), panelGroupId: "g-1" }, "network_access")).toMatchObject({ panelGroupId: "g-1" });
    expect(variantBody({ ...form(), panelGroupId: "" }, "network_access")).not.toHaveProperty("panelGroupId");
    // A group picked, then the product's kind changed in the wizard: billing would store it on a product nothing places.
    expect(variantBody({ ...form(), panelGroupId: "g-1" }, "feature_access")).not.toHaveProperty("panelGroupId");
  });

  it("clears a group on edit with null, which billing's schema takes", () => {
    expect(panelGroupPatch("g-2")).toEqual({ panelGroupId: "g-2" });
    expect(panelGroupPatch("")).toEqual({ panelGroupId: null });
    const schema = read("billing-service/src/app/catalog/catalog-admin.schema.ts");
    expect(schema).toMatch(/panelGroupId: uuid\('panelGroupId'\)\.nullable\(\)\.optional\(\)/);
  });

  it("marks a network_access variant with no group as not for sale — the shop hides it", () => {
    expect(notForSale({ panelGroupId: null }, "network_access")).toBe(true);
    expect(notForSale({ panelGroupId: "g-1" }, "network_access")).toBe(false);
    expect(notForSale({ panelGroupId: null }, "feature_access")).toBe(false);
  });

  it("names every string it shows in en and fa", () => {
    for (const lang of ["en", "fa"]) {
      const v = JSON.parse(readFileSync(join(LOCALES, lang, "common.json"), "utf8")).catalog.variant;
      for (const k of ["panelGroup", "panelGroupHint", "panelGroupNone", "notForSale", "healthy", "notFulfilled", "panelGroupsFailed"]) expect(v[k], `${lang} ${k}`).toBeTruthy();
    }
  });
});

describe("a new price", () => {
  const TODAY = "2026-09-14";

  it("starts now when it is for today, and at the first Tehran instant of a later day", () => {
    expect(priceBody({ amount: "7", day: TODAY }, TODAY)).toEqual({ amount: "7" });
    expect(priceBody({ amount: "7", day: "" }, TODAY)).toEqual({ amount: "7" });
    expect(priceBody({ amount: "7", day: "2026-10-01" }, TODAY)).toEqual({ amount: "7", effectiveFrom: "2026-10-01T00:00:00+03:30" });
  });

  it("refuses a day already past, and an amount that is not a price", () => {
    expect(validatePriceForm({ amount: "7", day: "2026-09-13" }, TODAY)).toHaveProperty("day");
    expect(validatePriceForm({ amount: "", day: "" }, TODAY)).toHaveProperty("amount");
    expect(validatePriceForm({ amount: "7", day: TODAY }, TODAY)).toEqual({});
  });
});

describe("currentPrice", () => {
  const price = (id: string, effectiveFrom: string, isActive = true): CatalogPrice => ({ id, variantId: "v1", amount: "1.00", currencyCode: "USD", effectiveFrom, isActive });
  const NOW = new Date("2026-09-14T12:00:00Z");

  it("is the newest active price already in effect — not a future one, not a switched-off one", () => {
    const history = [
      price("p1", "2026-01-01T00:00:00.000Z"),
      price("p2", "2026-06-01T00:00:00.000Z"),
      price("p3", "2026-09-01T00:00:00.000Z", false),
      price("p4", "2026-12-01T00:00:00.000Z"),
    ];
    expect(currentPrice(history, NOW)?.id).toBe("p2");
    expect(currentPrice([price("p4", "2026-12-01T00:00:00.000Z")], NOW)).toBeNull();
  });
});

describe("the translation review", () => {
  const draft = (lang: string, key: string, text: string) => ({ lang, key, draft: text });

  it("publishes an untouched draft as it is and an edited one as the reviewer's text, per language", () => {
    const items = [draft("de", "catalog.product.a.name", "A"), draft("de", "catalog.product.b.name", "B"), draft("tr", "catalog.product.a.name", "A-tr")];
    const edits = {
      [editId(items[1])]: "  Bee ",
      [editId(items[2])]: "A-tr", // typed back to the draft: still a plain publish
    };
    expect(reviewWrites(items, edits)).toEqual([
      { lang: "de", keys: ["catalog.product.a.name"] },
      { lang: "de", keys: ["catalog.product.b.name"], texts: { "catalog.product.b.name": "Bee" } },
      { lang: "tr", keys: ["catalog.product.a.name"] },
    ]);
  });

  it("never sends a draft cleared to blank", () => {
    const item = draft("de", "catalog.product.a.name", "A");
    expect(reviewWrites([item], { [editId(item)]: "   " })).toEqual([]);
  });
});

describe("removing products in a group (F-026-h/i)", () => {
  it("reports each outcome once, as a count, deleted before archived before not found, and nothing it did not do", () => {
    const R = CATALOG_KEYS.removal;
    expect(
      removalReport([
        { id: "a", outcome: "archived" },
        { id: "b", outcome: "deleted" },
        { id: "c", outcome: "not_found" },
        { id: "d", outcome: "deleted" },
      ]),
    ).toEqual([
      { key: R.deleted, count: 2 },
      { key: R.archived, count: 1 },
      { key: R.notFound, count: 1 },
    ]);
    expect(removalReport([{ id: "a", outcome: "deleted" }])).toEqual([{ key: R.deleted, count: 1 }]);
  });

  it("keeps a selection only for products still in the list after it is read again", () => {
    expect(stillSelected(new Set(["a", "gone", "c"]), [{ id: "a" }, { id: "b" }, { id: "c" }])).toEqual(new Set(["a", "c"]));
  });
});

describe("categories in a group (F-026-j/k)", () => {
  const C = CATALOG_KEYS.categories;

  it("has a line for every outcome billing answers, and reports each once, deleted before kept before not found", () => {
    const field = /export type CategoryRemovalOutcome = \{[^}]*outcome: ([^;}]*)/.exec(read("billing-service/src/app/catalog/catalog-admin.service.ts"));
    if (!field) throw new Error("CategoryRemovalOutcome no longer has an outcome union — this test is stale");
    expect([...field[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual(["archived", "deleted", "has_children", "has_products", "not_found"]);
    expect(
      categoryRemovalReport([
        { id: "a", outcome: "has_products" },
        { id: "b", outcome: "not_found" },
        { id: "c", outcome: "deleted" },
        { id: "d", outcome: "has_products" },
        { id: "e", outcome: "has_children" },
      ]),
    ).toEqual([
      { key: C.deleted, count: 1 },
      { key: C.hasProducts, count: 2 },
      { key: C.hasChildren, count: 1 },
      { key: C.notFound, count: 1 },
    ]);
  });

  it("reports a category archived with its products, and what happened to the products, once each (F-026-m)", () => {
    const R = CATALOG_KEYS.removal;
    expect(
      categoryRemovalReport([
        { id: "a", outcome: "archived", products: { deleted: 1, archived: 2, unlinked: 0 } },
        { id: "b", outcome: "deleted", products: { deleted: 3, archived: 0, unlinked: 2 } },
        { id: "c", outcome: "has_products", products: { deleted: 0, archived: 0, unlinked: 0 } },
      ]),
    ).toEqual([
      { key: C.deleted, count: 1 },
      { key: C.archived, count: 1 },
      { key: C.hasProducts, count: 1 },
      { key: R.deleted, count: 4 },
      { key: R.archived, count: 2 },
      { key: C.unlinked, count: 2 },
    ]);
  });

  it("asks again only for the categories billing kept for their products, and the second answer replaces the first", () => {
    const first = [
      { id: "a", outcome: "deleted" as const },
      { id: "b", outcome: "has_products" as const },
      { id: "c", outcome: "not_found" as const },
    ];
    expect(heldByProducts(first)).toEqual(["b"]);
    expect(mergeRemovals(first, [{ id: "b", outcome: "archived", products: { deleted: 0, archived: 1, unlinked: 0 } }])).toEqual([
      { id: "a", outcome: "deleted" },
      { id: "b", outcome: "archived", products: { deleted: 0, archived: 1, unlinked: 0 } },
      { id: "c", outcome: "not_found" },
    ]);
  });

  it("restores an archived category with the one patch billing's schema takes for it (F-026-n)", () => {
    expect(RESTORE_CATEGORY).toEqual({ archived: false });
    const schema = /export const updateCategorySchema = z([\s\S]*?)\.strict\(\);/.exec(read("billing-service/src/app/catalog/catalog-admin.schema.ts"));
    if (!schema) throw new Error("updateCategorySchema moved — this test is stale");
    expect(schema[1]).toMatch(/archived: z\.literal\(false\)/);
  });

  it("counts an archived product in its category, because billing refuses to remove that category for it", () => {
    const counts = productCounts([{ categoryIds: ["x", "y"] }, { categoryIds: ["y"] }], [{ categoryIds: ["x"] }]);
    expect(counts.get("x")).toBe(2);
    expect(counts.get("y")).toBe(2);
    expect(counts.get("empty")).toBeUndefined();
  });

  it("switches only the selected categories that are not already in the asked state", () => {
    const cats = [
      { id: "on1", isActive: true },
      { id: "off1", isActive: false },
      { id: "on2", isActive: true },
      { id: "unpicked", isActive: false },
    ];
    const picked = new Set(["on1", "off1", "on2"]);
    expect(switchTargets(picked, cats, false)).toEqual(["on1", "on2"]);
    expect(switchTargets(picked, cats, true)).toEqual(["off1"]);
  });

  it("reports how many switched and how many failed, each only when it happened", () => {
    const ok: PromiseSettledResult<unknown> = { status: "fulfilled", value: {} };
    const no: PromiseSettledResult<unknown> = { status: "rejected", reason: new Error("x") };
    expect(switchReport([ok, no, ok])).toEqual([
      { key: C.switched, count: 2 },
      { key: C.switchFailed, count: 1 },
    ]);
    expect(switchReport([ok])).toEqual([{ key: C.switched, count: 1 }]);
    expect(switchReport([])).toEqual([]);
  });
});

describe("the menu", () => {
  it("shows the catalog page only to a holder of catalog.manage", () => {
    const links = PANEL_MENU.flatMap((e) => (isMenuGroup(e) ? e.children : [e]));
    expect(links.find((l) => l.href === PANEL_CATALOG)?.requires).toEqual([CATALOG_MANAGE]);
  });
});

describe("categories as a tree (F-026-s over F-026-r)", () => {
  const cat = (id: string, parentId: string | null, key = id) => ({ id, parentId, key });
  // vpn > fast > gaming; vpn > slow; games (top); orphan's parent is not in the list (another tenant's).
  const cats = [cat("gaming", "fast"), cat("games", null), cat("slow", "vpn"), cat("fast", "vpn"), cat("vpn", null), cat("orphan", "gone")];

  it("keeps billing's depth cap", () => {
    const shared = read("shared-core/src/lib/catalog/category-tree.ts");
    expect(shared).toContain(`export const CATEGORY_MAX_DEPTH = ${CATEGORY_MAX_DEPTH};`);
  });

  it("lists every category once, each under its parent, by key; one whose parent is not listed goes to the top", () => {
    expect(categoryTree(cats).map((n) => `${n.depth}:${n.category.id}`)).toEqual(["0:games", "0:orphan", "0:vpn", "1:fast", "2:gaming", "1:slow"]);
  });

  it("names a category by its path from the top", () => {
    expect(categoryPath(cats, "gaming", (c) => c.key)).toBe("vpn › fast › gaming");
  });

  it("offers as a parent neither the category itself, nor anything under it, nor a place that would pass the cap", () => {
    // `fast` spans two levels (fast > gaming): it fits only at the top or right under a top-level one.
    expect(parentChoices(cats, "fast").map((c) => c.id).sort()).toEqual(["games", "orphan", "vpn"]);
    // A new category (one level) goes anywhere above level three.
    expect(parentChoices(cats, null).map((c) => c.id).sort()).toEqual(["fast", "games", "orphan", "slow", "vpn"]);
  });

  it("sends a move with the one field billing's patch takes, null for the top", () => {
    expect(moveBody("")).toEqual({ parentId: null });
    expect(moveBody(UUID)).toEqual({ parentId: UUID });
  });
});

describe("every key this page can reach", () => {
  const flatten = (v: unknown): string[] =>
    typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(flatten) : [];
  const shipped = (lang: string) => {
    const out = new Set<string>();
    const walk = (prefix: string, value: unknown) => {
      if (value && typeof value === "object") for (const [k, c] of Object.entries(value)) walk(prefix ? `${prefix}.${k}` : k, c);
      else if (typeof value === "string") out.add(prefix);
    };
    walk("", JSON.parse(readFileSync(join(LOCALES, lang, "common.json"), "utf8")));
    return out;
  };

  it.each(["en", "fa"])("resolves in %s", (lang) => {
    const keys = shipped(lang);
    expect(flatten(CATALOG_KEYS).filter((k) => !keys.has(k))).toEqual([]);
  });
});

describe("a metered variant's rate per GB (F-118-m, ADR-0105 decision 10)", () => {
  const GIB = String(2 ** 30);
  const metered = () => ({ ...emptyVariantForm(), sku: "vpn-payg", price: "0", billingMode: "metered" as const, rateMode: "postpaid" as const, ratePerGb: "0.00045" });
  const card = (id: string, effectiveFrom: string, patch: Partial<CatalogRateCard> = {}): CatalogRateCard => ({
    id, variantId: "v1", meterKey: "vpn.traffic", unitSize: GIB, unitPrice: "0.5", currencyCode: "USD", mode: "prepaid",
    includedQuantity: "0", afterIncluded: "metered", effectiveFrom, isActive: true, ...patch,
  });
  const NOW = new Date("2026-09-29T12:00:00Z");
  const TODAY = "2026-09-29";

  it("sends a metered variant with its first card: vpn.traffic per GiB, nothing included, the mode picked — the only shape billing serves", () => {
    expect(validateVariantForm(metered())).toEqual({});
    expect(variantBody(metered(), "network_access").rateCard).toEqual({
      meterKey: "vpn.traffic", unitSize: GIB, unitPrice: "0.00045", mode: "postpaid", afterIncluded: "metered",
    });
    // A prepaid variant sends none: a package plan never reads a card, and billing refuses one on it.
    expect(variantBody({ ...metered(), billingMode: "prepaid" }, "network_access")).not.toHaveProperty("rateCard");
  });

  it.each(["", "0", "0.000", "-1", "1.123456789", "abc"])("refuses %o as a metered variant's rate", (ratePerGb) => {
    expect(validateVariantForm({ ...metered(), ratePerGb })).toHaveProperty("ratePerGb");
  });

  it("asks no rate of a prepaid variant", () => {
    expect(validateVariantForm({ ...metered(), billingMode: "prepaid", ratePerGb: "", quotas: [] })).toEqual({});
  });

  it("writes a new card as a price is written: from now, or from a later day's first instant in Tehran; never a day past", () => {
    expect(rateCardBody({ mode: "prepaid", unitPrice: "0.5", day: "" }, TODAY)).toEqual({
      meterKey: "vpn.traffic", unitSize: GIB, unitPrice: "0.5", mode: "prepaid", afterIncluded: "metered",
    });
    expect(rateCardBody({ mode: "postpaid", unitPrice: "0.5", day: "2026-10-01" }, TODAY)).toMatchObject({ mode: "postpaid", effectiveFrom: "2026-10-01T00:00:00+03:30" });
    expect(validateRateCardForm({ mode: "prepaid", unitPrice: "0.5", day: "2026-09-28" }, TODAY)).toHaveProperty("day");
    expect(validateRateCardForm({ mode: "prepaid", unitPrice: "0", day: "" }, TODAY)).toHaveProperty("unitPrice");
    expect(validateRateCardForm({ mode: "prepaid", unitPrice: "0.5", day: TODAY }, TODAY)).toEqual({});
  });

  it("shows billing's card in effect: the newest active vpn.traffic one, not a future or switched-off one", () => {
    const history = [card("c1", "2026-01-01T00:00:00Z"), card("c2", "2026-06-01T00:00:00Z"), card("c3", "2026-09-01T00:00:00Z", { isActive: false }), card("c4", "2026-12-01T00:00:00Z")];
    expect(currentRateCard(history, NOW)?.id).toBe("c2");
    expect(currentRateCard([card("c5", "2026-01-01T00:00:00Z", { meterKey: "api.calls" })], NOW)).toBeNull();
  });

  it("marks a metered variant with no card in effect as not for sale; a prepaid one never", () => {
    expect(noRate({ billingMode: "metered", rateCards: [] }, NOW)).toBe(true);
    expect(noRate({ billingMode: "metered", rateCards: [card("c1", "2026-01-01T00:00:00Z")] }, NOW)).toBe(false);
    expect(noRate({ billingMode: "prepaid", rateCards: [] }, NOW)).toBe(false);
  });

  it("shows a rate to every place it was written in, never fewer than the currency's own", () => {
    expect(rateDecimals("0.00045", 2)).toBe(5);
    expect(rateDecimals("0.5", 2)).toBe(2);
    expect(rateDecimals("1500", 0)).toBe(0);
  });
});
