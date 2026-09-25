import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Me } from "@/lib/auth-api";
import type { AdminCoupon } from "@/lib/billing-api";
import { PANEL_COUPONS } from "@/lib/routes";
import { PANEL_MENU, isMenuGroup } from "../_lib/panel-menu";
import {
  COUPON_KEYS,
  COUPON_MANAGE,
  REFUSAL_KEYS,
  STATUS_TONES,
  USAGE_STATUSES,
  createBody,
  dayToInstant,
  emptyCouponForm,
  emptyUsageFilter,
  formFromCoupon,
  instantToDay,
  isFrozen,
  updateBody,
  usageQuery,
  validateCouponForm,
  validateUsageFilter,
} from "./_lib/coupon-form";
import { variantChoices, variantOwnerTenant } from "./_lib/variant-choices";
import type { CatalogProductDetail, CatalogVariant } from "@/lib/catalog-api";

/**
 * The coupons page, tab 1 — discount coupons (F-502-g, D-33). What breaks
 * without a browser to see it:
 *  - **a refusal with no sentence.** Billing answers a `reason`; every reason
 *    `CouponAdminService` can send has a line here, read out of its own source;
 *  - **the form sending what billing refuses** — a wasted round trip with a
 *    generic error. The rules mirror `coupon-admin.service.ts`;
 *  - **an edit rewriting fields nobody touched** — a used coupon's value is
 *    frozen, so a full body would be refused for a label change;
 *  - **a day that lands on the wrong day.** A picked day is Tehran's, the
 *    market's clock (F-502-k): `validFrom` is its first instant, `expiresAt` the
 *    first instant of the next day;
 *  - **the menu entry** shown without `coupon.manage`.
 */
const REPO = join(__dirname, "../../../../..");
const SERVICE = join(REPO, "txnet-backend/billing-service/src/app/payment/coupon-admin/coupon-admin.service.ts");
const LOCALES = join(REPO, "locales/frontend/langs");

const OWNER: Me = {
  userId: "u1",
  fullName: "Theora",
  role: { id: "r1", name: "SuperAdmin" },
  permissions: ["*"],
  tenant: { id: "t-owner", type: "platform_owner", isOwner: false },
  email: null,
  isImpersonated: false,
};
const RESELLER: Me = { ...OWNER, role: { id: "r2", name: "Admin" }, permissions: ["coupon.manage"], tenant: { id: "t-res", type: "reseller", isOwner: false } };
const UUID = "22222222-2222-4222-8222-222222222222";

const COUPON: AdminCoupon = {
  id: "c1",
  tenantId: "t-res",
  code: "NOWRUZ",
  discountType: "percentage",
  discountValue: "10.00",
  maxDiscountCap: "5.00",
  minPurchaseAmount: null,
  maxPurchaseAmount: null,
  totalUsageLimit: 100,
  perUserUsageLimit: 1,
  usedCount: 3,
  reservedCount: 2,
  frozen: true,
  expiresAt: "2026-03-20T20:30:00.000Z",
  validFrom: null,
  isActive: true,
  visibility: "public",
  activeWeekdays: [],
  activeHourFrom: null,
  activeHourTo: null,
  firstPurchaseOnly: false,
  newUserWithinDays: null,
  periodUsageLimit: null,
  periodDays: null,
  allowedChannels: [],
  label: "Nowruz",
  note: null,
  batchId: null,
  allowedUserIds: [],
  tenantIds: [],
  gateways: [],
  serviceScopes: [],
  grantVariantId: null,
  status: "active",
  deletedAt: null,
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
};

function unionOf(name: string): string[] {
  const union = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(readFileSync(SERVICE, "utf8"));
  if (!union) throw new Error(`${name} is no longer a literal union — this test is stale`);
  return [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe("what billing can refuse", () => {
  it("has a sentence for every reason", () => {
    expect(Object.keys(REFUSAL_KEYS).sort()).toEqual(unionOf("CouponAdminRejection").sort());
  });

  it("has a tone for every status", () => {
    expect(Object.keys(STATUS_TONES).sort()).toEqual(unionOf("CouponStatus").sort());
  });
});

describe("validateCouponForm", () => {
  const valid = () => ({ ...emptyCouponForm(), code: "yalda", discountValue: "15" });

  it("accepts a plain percentage coupon", () => {
    expect(validateCouponForm(valid(), RESELLER, null)).toEqual({});
  });

  it.each([
    [{ code: "a!" }, "code", COUPON_KEYS.errors.code],
    [{ discountValue: "0" }, "discountValue", COUPON_KEYS.errors.decimal],
    [{ discountValue: "101" }, "discountValue", COUPON_KEYS.errors.percentMax],
    [{ discountType: "fixed_amount" as const, maxDiscountCap: "5" }, "maxDiscountCap", COUPON_KEYS.errors.capPercentOnly],
    [{ minPurchaseAmount: "50", maxPurchaseAmount: "10" }, "maxPurchaseAmount", COUPON_KEYS.errors.range],
    [{ activeHourFrom: "22" }, "activeHourTo", COUPON_KEYS.errors.pair],
    [{ activeHourFrom: "5", activeHourTo: "5" }, "activeHourTo", COUPON_KEYS.errors.range],
    [{ periodDays: "7" }, "periodUsageLimit", COUPON_KEYS.errors.pair],
    [{ validFrom: "2026-10-02", expiresAt: "2026-10-01" }, "expiresAt", COUPON_KEYS.errors.dates],
    [{ visibility: "targeted" as const }, "allowedUserIds", COUPON_KEYS.errors.targetedNeedsUsers],
    [{ visibility: "targeted" as const, allowedUserIds: "not-a-uuid" }, "allowedUserIds", COUPON_KEYS.errors.uuid],
    [{ perUserUsageLimit: "1.5" }, "perUserUsageLimit", COUPON_KEYS.errors.integer],
  ])("refuses %o on %s", (patch, field, key) => {
    expect(validateCouponForm({ ...valid(), ...patch }, RESELLER, null)).toMatchObject({ [field]: key });
  });

  it("asks the platform owner for a tenant id when the coupon is another tenant's", () => {
    expect(validateCouponForm({ ...valid(), owner: "tenant", tenantId: "" }, OWNER, null)).toMatchObject({ tenantId: COUPON_KEYS.errors.uuid });
  });

  it("never lets an edit drop capacity below used + reserved", () => {
    const form = { ...formFromCoupon(COUPON), totalUsageLimit: "4" };
    expect(validateCouponForm(form, RESELLER, COUPON)).toMatchObject({ totalUsageLimit: COUPON_KEYS.errors.capacityBelowUsed });
    expect(validateCouponForm({ ...form, totalUsageLimit: "5" }, RESELLER, COUPON)).toEqual({});
  });
});

describe("createBody", () => {
  it("sends a reseller's coupon with no tenant, and trims what billing would", () => {
    const body = createBody({ ...emptyCouponForm(), code: " yalda ", discountValue: "15", label: "  " }, RESELLER);
    expect(body).toEqual({ code: "YALDA", discountType: "percentage", discountValue: "15", isActive: true, visibility: "public", perUserUsageLimit: 1 });
  });

  it("names the owner's choice: platform is null, another tenant its id", () => {
    const base = { ...emptyCouponForm(), code: "WELCOME", discountValue: "5" };
    expect(createBody({ ...base, owner: "platform", tenantIds: UUID }, OWNER)).toMatchObject({ tenantId: null, tenantIds: [UUID] });
    expect(createBody({ ...base, owner: "tenant", tenantId: UUID }, OWNER)).toMatchObject({ tenantId: UUID });
    expect(createBody({ ...base, owner: "tenant", tenantId: UUID }, RESELLER)).not.toHaveProperty("tenantId");
  });

  it("turns picked days into Tehran instants and limits into their wire shapes", () => {
    const body = createBody(
      { ...emptyCouponForm(), code: "NIGHT", discountValue: "5", validFrom: "2026-10-01", expiresAt: "2026-10-31", activeHourFrom: "22", activeHourTo: "2", activeWeekdays: [5, 4], allowedChannels: ["bot"], gateways: ["platform:" + UUID] },
      RESELLER,
    );
    expect(body).toMatchObject({
      validFrom: "2026-10-01T00:00:00+03:30",
      expiresAt: "2026-11-01T00:00:00+03:30",
      activeHourFrom: 22,
      activeHourTo: 2,
      activeWeekdays: [4, 5],
      allowedChannels: ["bot"],
      gateways: [{ source: "platform", id: UUID }],
    });
  });
});

describe("updateBody", () => {
  it("sends only what changed, so a used coupon's frozen value is never restated", () => {
    const form = { ...formFromCoupon(COUPON), label: "Nowruz 1405", isActive: false };
    expect(updateBody(form, COUPON)).toEqual({ label: "Nowruz 1405", isActive: false });
    expect(updateBody(formFromCoupon(COUPON), COUPON)).toEqual({});
  });

  it("clears an optional field as null", () => {
    expect(updateBody({ ...formFromCoupon(COUPON), maxDiscountCap: "" }, COUPON)).toEqual({ maxDiscountCap: null });
  });

  it("freezes on billing's own flag, not on the counters it can see", () => {
    expect(isFrozen(COUPON)).toBe(true);
    // A coupon whose redemptions were all released: no counter, still frozen (F-502-o).
    const released: AdminCoupon = { ...COUPON, usedCount: 0, reservedCount: 0 };
    expect(isFrozen(released)).toBe(true);
    expect(isFrozen({ ...COUPON, frozen: false })).toBe(false);
  });
});

describe("days and instants", () => {
  it("round-trips a picked day through Tehran's clock", () => {
    expect(instantToDay(dayToInstant("2026-10-01", "start"), "start")).toBe("2026-10-01");
    expect(instantToDay(dayToInstant("2026-10-31", "end"), "end")).toBe("2026-10-31");
    expect(instantToDay(COUPON.expiresAt, "end")).toBe("2026-03-20");
  });
});

/**
 * The usage report's filters (F-502-i). Billing reads `from` as `gte` and `to`
 * as `lte` over `redeemedAt`, so a picked "to" day ends on its own last instant
 * in Tehran — not the next midnight, which would count a redemption at 00:00.
 */
describe("the usage filter", () => {
  it("offers exactly billing's redemption statuses", () => {
    const prisma = readFileSync(join(REPO, "txnet-backend/prisma/domains/billing.prisma"), "utf8");
    const values = /enum RedemptionStatus \{([^}]*)\}/.exec(prisma)![1].split("\n").map((l) => l.trim()).filter((l) => /^[a-z_]+$/.test(l));
    expect([...USAGE_STATUSES].sort()).toEqual(values.sort());
  });

  it("sends only the page when nothing is filtered", () => {
    expect(usageQuery(emptyUsageFilter(), 3)).toEqual({ page: 3, pageSize: 20 });
  });

  it("sends a status and an inclusive Tehran day range", () => {
    expect(usageQuery({ status: "confirmed", from: "2026-10-01", to: "2026-10-31" }, 1)).toEqual({
      status: "confirmed",
      from: "2026-10-01T00:00:00+03:30",
      to: "2026-10-31T23:59:59.999+03:30",
      page: 1,
      pageSize: 20,
    });
  });

  it("refuses a range that ends before it starts, and allows a single day", () => {
    expect(validateUsageFilter({ status: "", from: "2026-10-02", to: "2026-10-01" })).toBe(COUPON_KEYS.usage.filters.badRange);
    expect(validateUsageFilter({ status: "", from: "2026-10-01", to: "2026-10-01" })).toBeNull();
    expect(validateUsageFilter({ status: "", from: "2026-10-01", to: "" })).toBeNull();
  });
});

/**
 * A free-service coupon (F-502-l-c, D-35): it gives a Grant of one catalog
 * variant, so it names that variant and no value, and it is redeemed in the
 * gift box — so, as billing refuses them, it takes no purchase, period or
 * time-of-day limit.
 */
describe("a free-service coupon", () => {
  const free = () => ({ ...emptyCouponForm(), code: "freevpn", discountType: "free_grant" as const, discountValue: "", grantVariantId: UUID });

  it("needs a variant and no value", () => {
    expect(validateCouponForm(free(), RESELLER, null)).toEqual({});
    expect(validateCouponForm({ ...free(), grantVariantId: "" }, RESELLER, null)).toMatchObject({ grantVariantId: COUPON_KEYS.errors.uuid });
    expect(validateCouponForm({ ...free(), grantVariantId: "nope" }, RESELLER, null)).toMatchObject({ grantVariantId: COUPON_KEYS.errors.uuid });
  });

  it.each([
    [{ minPurchaseAmount: "5" }, "minPurchaseAmount"],
    [{ maxPurchaseAmount: "50" }, "maxPurchaseAmount"],
    [{ periodUsageLimit: "1", periodDays: "7" }, "periodUsageLimit"],
    [{ activeHourFrom: "8", activeHourTo: "20" }, "activeHourFrom"],
    [{ validFrom: "2026-10-01" }, "validFrom"],
    [{ newUserWithinDays: "7" }, "newUserWithinDays"],
    // F-502-n: a discount coupon edited into a free service keeps these until the form clears them.
    [{ gateways: ["tenant:" + UUID] }, "gateways"],
    [{ productIds: UUID }, "productIds"],
    [{ variantIds: UUID }, "variantIds"],
  ])("refuses %o on %s, as billing does", (patch, field) => {
    expect(validateCouponForm({ ...free(), ...patch }, RESELLER, null)).toMatchObject({ [field]: COUPON_KEYS.errors.notForFreeService });
  });

  it("sends the variant with a value of 0 and no cap", () => {
    const body = createBody({ ...free(), maxDiscountCap: "9" }, RESELLER);
    expect(body).toMatchObject({ code: "FREEVPN", discountType: "free_grant", discountValue: "0", grantVariantId: UUID });
    expect(body).not.toHaveProperty("maxDiscountCap");
  });

  it("sends no variant for any other type", () => {
    expect(createBody({ ...emptyCouponForm(), code: "yalda", discountValue: "15", grantVariantId: UUID }, RESELLER)).not.toHaveProperty("grantVariantId");
  });

  it("keeps the type and the variant when an existing one is edited", () => {
    const form = formFromCoupon({ ...COUPON, discountType: "free_grant", discountValue: "0.00", maxDiscountCap: null, grantVariantId: UUID });
    expect(form).toMatchObject({ discountType: "free_grant", grantVariantId: UUID });
  });
});

describe("the variant picker", () => {
  const variant = (patch: Partial<CatalogVariant>): CatalogVariant => ({
    id: "v",
    tenantId: null,
    productId: "p",
    sku: "SKU",
    nameKey: null,
    quotas: {},
    durationDays: 30,
    billingMode: "prepaid",
    visibility: "public",
    panelGroupId: null,
    qualityTier: "standard",
    isActive: true,
    prices: [],
    ...patch,
  });
  const product = (patch: Partial<CatalogProductDetail>): CatalogProductDetail => ({
    id: "p",
    tenantId: null,
    categoryId: "c",
    key: "vpn",
    nameKey: "k",
    sourceLang: "fa",
    descriptionKey: null,
    fulfilmentKind: "network_access",
    featureKeys: [],
    defaultQuotas: {},
    isActive: true,
    archivedAt: null,
    variants: [],
    ...patch,
  });

  it("offers the platform's and the owner's live variants, whatever their visibility", () => {
    const catalog = [
      product({ key: "vpn", variants: [variant({ id: "a", sku: "M1" }), variant({ id: "b", sku: "HIDDEN", visibility: "admin_only" }), variant({ id: "c", isActive: false })] }),
      product({ id: "p2", key: "res", tenantId: "t-res", variants: [variant({ id: "d", tenantId: "t-res", sku: "R1", durationDays: null })] }),
      product({ id: "p3", key: "other", tenantId: "t-x", variants: [variant({ id: "e", tenantId: "t-x" })] }),
      product({ id: "p4", key: "off", isActive: false, variants: [variant({ id: "f" })] }),
    ];
    expect(variantChoices(catalog, "t-res").map((c) => c.value)).toEqual(["a", "b", "d"]);
    expect(variantChoices(catalog, null).map((c) => c.value)).toEqual(["a", "b"]);
    const d = variantChoices(catalog, "t-res").find((c) => c.value === "d")!;
    expect(d).toMatchObject({ product: "res", sku: "R1", durationDays: null });
  });

  it("asks billing's question: whose coupon is it", () => {
    expect(variantOwnerTenant("own", "", RESELLER)).toBe("t-res");
    expect(variantOwnerTenant("platform", "", OWNER)).toBeNull();
    expect(variantOwnerTenant("tenant", " t-9 ", OWNER)).toBe("t-9");
    // Only the platform owner chooses; anyone else's coupon is its own.
    expect(variantOwnerTenant("platform", "", RESELLER)).toBe("t-res");
  });
});

describe("the menu", () => {
  it("shows the coupons page only to a holder of coupon.manage", () => {
    const links = PANEL_MENU.flatMap((e) => (isMenuGroup(e) ? e.children : [e]));
    expect(links.find((l) => l.href === PANEL_COUPONS)?.requires).toEqual([COUPON_MANAGE]);
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
    expect(flatten(COUPON_KEYS).filter((k) => !keys.has(k))).toEqual([]);
  });
});
