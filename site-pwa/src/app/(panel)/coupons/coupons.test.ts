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
  createBody,
  dayToInstant,
  emptyCouponForm,
  formFromCoupon,
  instantToDay,
  isUsed,
  updateBody,
  validateCouponForm,
} from "./_lib/coupon-form";

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
  tenant: { id: "t-owner", type: "platform_owner" },
  isImpersonated: false,
};
const RESELLER: Me = { ...OWNER, role: { id: "r2", name: "Admin" }, permissions: ["coupon.manage"], tenant: { id: "t-res", type: "reseller" } };
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

  it("knows a coupon with a hold or a use is used", () => {
    expect(isUsed(COUPON)).toBe(true);
    expect(isUsed({ ...COUPON, usedCount: 0, reservedCount: 0 })).toBe(false);
  });
});

describe("days and instants", () => {
  it("round-trips a picked day through Tehran's clock", () => {
    expect(instantToDay(dayToInstant("2026-10-01", "start"), "start")).toBe("2026-10-01");
    expect(instantToDay(dayToInstant("2026-10-31", "end"), "end")).toBe("2026-10-31");
    expect(instantToDay(COUPON.expiresAt, "end")).toBe("2026-03-20");
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
