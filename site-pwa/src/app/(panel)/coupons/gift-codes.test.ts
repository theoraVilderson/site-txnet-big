import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Me } from "@/lib/auth-api";
import { GIFT_BATCH_MAX, GIFT_KEYS, emptyGiftBatchForm, giftBatchBody, validateGiftBatch } from "./_lib/gift-batch";
import { COUPON_KEYS } from "./_lib/coupon-form";

/**
 * The coupons page, tab 2 — gift codes (F-502-h, D-33). What breaks silently:
 *  - **a batch billing refuses** — the size limit and the prefix shape mirror
 *    `CouponBatchService`, and `GIFT_BATCH_MAX` is read against its source;
 *  - **owner-only fields sent by a reseller**, which billing would refuse as
 *    `not_platform_owner` after the admin thought the batch was made;
 *  - **an expiry a day short**: the day picked is included, in Tehran time.
 */
const REPO = join(__dirname, "../../../../..");
const BATCH_SERVICE = join(REPO, "txnet-backend/billing-service/src/app/payment/coupon-admin/coupon-batch.service.ts");
const LOCALES = join(REPO, "locales/frontend/langs");

const OWNER: Me = {
  userId: "u1",
  fullName: "Theora",
  role: { id: "r1", name: "SuperAdmin" },
  permissions: ["*"],
  tenant: { id: "t-owner", type: "platform_owner" },
  email: null,
  isImpersonated: false,
};
const RESELLER: Me = { ...OWNER, permissions: ["coupon.manage"], tenant: { id: "t-res", type: "reseller" } };
const UUID = "22222222-2222-4222-8222-222222222222";

describe("validateGiftBatch", () => {
  const valid = () => ({ ...emptyGiftBatchForm(), label: "Yalda", count: "50", value: "5" });

  it("accepts a plain batch", () => {
    expect(validateGiftBatch(valid(), RESELLER)).toEqual({});
  });

  it("uses billing's own batch limit", () => {
    const source = readFileSync(BATCH_SERVICE, "utf8");
    expect(source).toContain(`export const GIFT_BATCH_MAX = ${GIFT_BATCH_MAX};`);
  });

  it.each([
    [{ label: "  " }, "label", GIFT_KEYS.errors.label],
    [{ count: "0" }, "count", GIFT_KEYS.errors.count],
    [{ count: String(GIFT_BATCH_MAX + 1) }, "count", GIFT_KEYS.errors.count],
    [{ count: "2.5" }, "count", GIFT_KEYS.errors.count],
    [{ value: "0" }, "value", COUPON_KEYS.errors.decimal],
    [{ prefix: "TOO-LONG-1" }, "prefix", GIFT_KEYS.errors.prefix],
    [{ tenantIds: "nope" }, "tenantIds", COUPON_KEYS.errors.uuid],
  ])("refuses %o on %s", (patch, field, key) => {
    expect(validateGiftBatch({ ...valid(), ...patch }, RESELLER)).toMatchObject({ [field]: key });
  });

  it("asks the owner for a tenant id when the batch is another tenant's", () => {
    expect(validateGiftBatch({ ...valid(), owner: "tenant" }, OWNER)).toMatchObject({ tenantId: COUPON_KEYS.errors.uuid });
  });
});

describe("giftBatchBody", () => {
  it("sends a reseller's batch with no owner fields, the prefix upper-cased and the day included", () => {
    const body = giftBatchBody({ ...emptyGiftBatchForm(), label: " Yalda ", count: "50", value: "5", prefix: "yld", expiresAt: "2026-12-21", owner: "platform", tenantIds: UUID }, RESELLER);
    expect(body).toEqual({ label: "Yalda", count: 50, value: "5", prefix: "YLD", expiresAt: "2026-12-22T00:00:00+03:30" });
  });

  it("names the owner's choice, and served tenants only on a platform batch", () => {
    const base = { ...emptyGiftBatchForm(), label: "x", count: "1", value: "1" };
    expect(giftBatchBody({ ...base, owner: "platform", tenantIds: UUID }, OWNER)).toMatchObject({ tenantId: null, tenantIds: [UUID] });
    expect(giftBatchBody({ ...base, owner: "tenant", tenantId: UUID, tenantIds: UUID }, OWNER)).toEqual({ label: "x", count: 1, value: "1", tenantId: UUID });
  });
});

/** A batch of free-service codes (F-502-l-c, D-35): a variant, and no value. */
describe("a free-service batch", () => {
  const service = () => ({ ...emptyGiftBatchForm(), label: "Free month", count: "20", kind: "service" as const, value: "", grantVariantId: UUID });

  it("needs a variant and no value", () => {
    expect(validateGiftBatch(service(), RESELLER)).toEqual({});
    expect(validateGiftBatch({ ...service(), grantVariantId: "nope" }, RESELLER)).toMatchObject({ grantVariantId: COUPON_KEYS.errors.uuid });
  });

  it("still needs a value for a credit batch, and no variant", () => {
    expect(validateGiftBatch({ ...service(), kind: "credit" }, RESELLER)).toMatchObject({ value: COUPON_KEYS.errors.decimal });
    expect(giftBatchBody({ ...service(), kind: "credit", value: "5" }, RESELLER)).not.toHaveProperty("grantVariantId");
  });

  it("sends the variant with a value of 0", () => {
    expect(giftBatchBody(service(), RESELLER)).toEqual({ label: "Free month", count: 20, value: "0", grantVariantId: UUID });
  });
});

describe("every gift key", () => {
  const flatten = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(flatten) : []);
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
    expect(flatten(GIFT_KEYS).filter((k) => !keys.has(k))).toEqual([]);
  });
});
