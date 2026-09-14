import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Me } from "@/lib/auth-api";
import type { CatalogPrice } from "@/lib/catalog-api";
import { PANEL_CATALOG } from "@/lib/routes";
import { PANEL_MENU, isMenuGroup } from "../_lib/panel-menu";
import {
  BILLING_MODES,
  CATALOG_KEYS,
  CATALOG_MANAGE,
  FULFILMENT_KINDS,
  QUALITY_TIERS,
  QUOTA_METRICS,
  REFUSAL_KEYS,
  RESET_POLICIES,
  VISIBILITIES,
  currentPrice,
  emptyProductForm,
  emptyVariantForm,
  priceBody,
  productBody,
  validatePriceForm,
  validateProductForm,
  validateVariantForm,
  variantBody,
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
 *  - **the menu entry** shown without `catalog.manage`.
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
  tenant: { id: "t-owner", type: "platform_owner" },
  isImpersonated: false,
};
const RESELLER: Me = { ...OWNER, role: { id: "r2", name: "Admin" }, permissions: ["catalog.manage"], tenant: { id: "t-res", type: "reseller" } };
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
  ])("offers exactly the %s enum", (name, file, offered) => {
    expect([...offered].sort()).toEqual(enumOf(file, name).sort());
  });

  it("offers exactly the schema's reset policies", () => {
    expect([...RESET_POLICIES].sort()).toEqual(tupleOf("billing-service/src/app/catalog/catalog-admin.schema.ts", "RESET_POLICIES").sort());
  });
});

describe("the product form", () => {
  const valid = () => ({ ...emptyProductForm(), categoryId: UUID, key: "vpn_pro", nameKey: "catalog.product.vpn_pro.name", featureKeys: "vpn.access" });

  it("accepts a plain product", () => {
    expect(validateProductForm(valid(), RESELLER)).toEqual({});
  });

  it.each([
    [{ key: "Bad Key" }, "key"],
    [{ nameKey: "no dots here" }, "nameKey"],
    [{ descriptionKey: "not a key" }, "descriptionKey"],
    [{ featureKeys: "vpn.access, Not-A-Key" }, "featureKeys"],
    [{ categoryId: "" }, "categoryId"],
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

  it("splits feature keys, trims and drops repeats, and leaves out a blank description", () => {
    const body = productBody({ ...valid(), featureKeys: " vpn.access,\napi.public  vpn.access " }, RESELLER);
    expect(body.featureKeys).toEqual(["vpn.access", "api.public"]);
    expect(body).not.toHaveProperty("descriptionKey");
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
    expect(variantBody(valid())).toEqual({
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
    expect(variantBody({ ...valid(), durationDays: "" })).toMatchObject({ durationDays: null });
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

  it("allows a free variant", () => {
    expect(validateVariantForm({ ...valid(), price: "0" })).toEqual({});
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
  const price = (id: string, effectiveFrom: string, isActive = true): CatalogPrice => ({ id, variantId: "v1", amount: "1.00", effectiveFrom, isActive });
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

describe("the menu", () => {
  it("shows the catalog page only to a holder of catalog.manage", () => {
    const links = PANEL_MENU.flatMap((e) => (isMenuGroup(e) ? e.children : [e]));
    expect(links.find((l) => l.href === PANEL_CATALOG)?.requires).toEqual([CATALOG_MANAGE]);
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
