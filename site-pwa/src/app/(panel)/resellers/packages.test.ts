import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { TenantPackage } from "@/lib/tenant-api";
import {
  GIB,
  PACKAGE_FEATURE_KEYS,
  PACKAGE_KEYS,
  WHOLESALE_METERS,
  createPackageBody,
  emptyPackageForm,
  otherRates,
  packageFormOf,
  updatePackageBody,
  validatePackage,
  type PackageForm,
} from "./_lib/packages";

/**
 * The platform owner's packages page (F-118-n5) and the reseller ledger's
 * names for what the wholesale leg writes. What breaks with nothing red:
 *  - **an edit that sends what it did not change.** A rate sent again is a no-op
 *    at the service, but a price cleared by accident is `package_price_in_use`
 *    or a subscriber's period with nothing to charge, and a rate left blank on
 *    purpose must reach the service as `unitPrice: null` — that switches the
 *    meter off, and a reseller on the package can no longer sell it (F-118-n2);
 *  - **a wholesale rate in the wrong unit.** The form asks for a price per GiB;
 *    the service stores `unitSize` bytes, so the body must say 2^30, and a rate
 *    written in another unit through the API is left alone, never re-read as
 *    per GiB;
 *  - **a feature or a ledger reason with no words.** Each is read from the
 *    service's own closed set, so a new one does not ship unnamed (the package
 *    routes' refusals are in `resellers.test.ts`, with the other services').
 */
const REPO = join(__dirname, "../../../../..");
const read = (path: string) => readFileSync(join(REPO, "txnet-backend", path), "utf8");

const PKG: TenantPackage = {
  id: "p1",
  name: "Silver",
  monthlyPrice: "30",
  yearlyPrice: null,
  currencyCode: "USD",
  includedFeatureKeys: ["coupon_engine", "own_gateway"],
  isActive: true,
  meterRates: [{ meterKey: "vpn.traffic", unitSize: String(GIB), unitPrice: "0.12", currencyCode: "USD", effectiveFrom: "2026-09-29T00:00:00.000Z" }],
};

const filled = (patch: Partial<PackageForm> = {}): PackageForm => ({
  ...emptyPackageForm(),
  name: "Gold",
  monthlyPrice: "40",
  ...patch,
});

describe("what the page offers is the service's own set", () => {
  it("the feature keys are shared-core's TENANT_FEATURE_KEYS, each with a name", () => {
    const tuple = /TENANT_FEATURE_KEYS = \[([\s\S]*?)\] as const/.exec(read("shared-core/src/lib/tenant/feature-keys.ts"));
    if (!tuple) throw new Error("TENANT_FEATURE_KEYS moved — this test is stale");
    const keys = [...tuple[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...PACKAGE_FEATURE_KEYS]).toEqual(keys);
    for (const key of keys) expect((PACKAGE_KEYS.features as Record<string, string>)[key], key).toBeTruthy();
  });

  it("every reason a reseller's billing wallet moves for has a name — the usage charge and its refund included", () => {
    const schema = read("prisma/domains/tenant.prisma");
    const body = /enum TenantBillingReasonType \{([\s\S]*?)\n\}/.exec(schema);
    if (!body) throw new Error("TenantBillingReasonType moved — this test is stale");
    const reasons = body[1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[a-z_]+$/.test(l));
    expect(reasons).toEqual(expect.arrayContaining(["metered_usage_charge", "metered_usage_refund"]));
    const labels = FrontendI18nKeys.common.tenantBilling.reason as Record<string, string>;
    for (const reason of reasons) expect(labels[reason], reason).toBeTruthy();
  });

  it("the wholesale meters are VPN traffic per GiB, an unlimited plan's time per 30 days (D-59 (c)) and a new link per use (F-118-r)", () => {
    expect(WHOLESALE_METERS.map(({ meterKey, unitSize }) => ({ meterKey, unitSize }))).toEqual([
      { meterKey: "vpn.traffic", unitSize: 1073741824 },
      { meterKey: "vpn.unlimited.time", unitSize: 2592000 },
      { meterKey: "vpn.config.regenerate", unitSize: 1 },
    ]);
  });

  it("each wholesale meter is a meter the catalog defines, with the unit it counts in", () => {
    const sql = readdirSync(join(REPO, "txnet-backend/prisma/domains/migrations"))
      .map((dir) => {
        try {
          return read(`prisma/domains/migrations/${dir}/migration.sql`);
        } catch {
          return "";
        }
      })
      .join("\n");
    expect(sql).toMatch(/'vpn\.traffic',\s*'bytes'/);
    expect(sql).toMatch(/'vpn\.unlimited\.time',\s*'seconds'/);
    expect(sql).toMatch(/'vpn\.config\.regenerate',\s*'count'/);
  });
});

describe("validatePackage", () => {
  it("takes a named package with one price", () => {
    expect(validatePackage(filled())).toEqual({});
  });

  it("refuses what the schema would: no name, no price, three places, zero, a rate past 8 places", () => {
    expect(validatePackage(filled({ name: "  " })).name).toBeTruthy();
    expect(validatePackage(filled({ monthlyPrice: "" })).monthlyPrice).toBeTruthy();
    expect(validatePackage(filled({ monthlyPrice: "1.234" })).monthlyPrice).toBeTruthy();
    expect(validatePackage(filled({ yearlyPrice: "0" })).yearlyPrice).toBeTruthy();
    expect(validatePackage(filled({ rates: { ...emptyPackageForm().rates, "vpn.traffic": "0.000000001" } })).rates).toBeTruthy();
    expect(validatePackage(filled({ rates: { ...emptyPackageForm().rates, "vpn.traffic": "0" } })).rates).toBeTruthy();
    expect(validatePackage(filled({ rates: { ...emptyPackageForm().rates, "vpn.traffic": "0.00000001" } }))).toEqual({});
    expect(validatePackage(filled({ rates: { ...emptyPackageForm().rates, "vpn.unlimited.time": "0" } })).rates).toBeTruthy();
  });
});

describe("createPackageBody", () => {
  it("sends the prices it has, and a rate per GiB only when one was given", () => {
    expect(createPackageBody(filled({ featureKeys: ["own_sms"] }))).toEqual({
      name: "Gold",
      monthlyPrice: "40",
      includedFeatureKeys: ["own_sms"],
    });
    expect(createPackageBody(filled({ rates: { "vpn.traffic": " 0.1 ", "vpn.unlimited.time": "", "vpn.config.regenerate": "" } })).meterRates).toEqual([
      { meterKey: "vpn.traffic", unitSize: "1073741824", unitPrice: "0.1" },
    ]);
  });

  it("an unlimited plan's flat price is sent per 30 days, in seconds", () => {
    expect(createPackageBody(filled({ rates: { "vpn.traffic": "", "vpn.unlimited.time": "4.5", "vpn.config.regenerate": "" } })).meterRates).toEqual([
      { meterKey: "vpn.unlimited.time", unitSize: "2592000", unitPrice: "4.5" },
    ]);
  });
});

describe("updatePackageBody", () => {
  it("an untouched form sends nothing", () => {
    expect(updatePackageBody(PKG, packageFormOf(PKG))).toBeNull();
    // the same features in another order are the same set
    expect(updatePackageBody(PKG, { ...packageFormOf(PKG), featureKeys: ["own_gateway", "coupon_engine"] })).toBeNull();
  });

  it("sends only the fields that changed; a cleared price is null", () => {
    const form = { ...packageFormOf(PKG), name: "Silver+", monthlyPrice: "", yearlyPrice: "300" };
    expect(updatePackageBody(PKG, form)).toEqual({ name: "Silver+", monthlyPrice: null, yearlyPrice: "300" });
  });

  it("a new rate is a whole rate per GiB; a cleared one switches the meter off", () => {
    expect(updatePackageBody(PKG, { ...packageFormOf(PKG), rates: { ...packageFormOf(PKG).rates, "vpn.traffic": "0.15" } })).toEqual({
      meterRates: [{ meterKey: "vpn.traffic", unitSize: "1073741824", unitPrice: "0.15" }],
    });
    expect(updatePackageBody(PKG, { ...packageFormOf(PKG), rates: { ...packageFormOf(PKG).rates, "vpn.traffic": "" } })).toEqual({
      meterRates: [{ meterKey: "vpn.traffic", unitPrice: null }],
    });
  });

  it("a rate written in another unit is never read as per GiB, and a blank field leaves it alone", () => {
    const odd: TenantPackage = { ...PKG, meterRates: [{ ...PKG.meterRates[0], unitSize: "1000000" }] };
    expect(packageFormOf(odd).rates["vpn.traffic"]).toBe("");
    expect(otherRates(odd)).toEqual(odd.meterRates);
    expect(updatePackageBody(odd, packageFormOf(odd))).toBeNull();
    expect(otherRates(PKG)).toEqual([]);
  });

  it("the unlimited rate is read, changed and cleared on its own, never touching the traffic rate", () => {
    const flat = { meterKey: "vpn.unlimited.time", unitSize: "2592000", unitPrice: "5", currencyCode: "USD", effectiveFrom: "2026-09-30T00:00:00.000Z" };
    const both: TenantPackage = { ...PKG, meterRates: [...PKG.meterRates, flat] };
    expect(packageFormOf(both).rates).toEqual({ "vpn.traffic": "0.12", "vpn.unlimited.time": "5", "vpn.config.regenerate": "" });
    expect(otherRates(both)).toEqual([]);
    expect(updatePackageBody(both, { ...packageFormOf(both), rates: { "vpn.traffic": "0.12", "vpn.unlimited.time": "6", "vpn.config.regenerate": "" } })).toEqual({
      meterRates: [{ meterKey: "vpn.unlimited.time", unitSize: "2592000", unitPrice: "6" }],
    });
    expect(updatePackageBody(both, { ...packageFormOf(both), rates: { "vpn.traffic": "0.12", "vpn.unlimited.time": "", "vpn.config.regenerate": "" } })).toEqual({
      meterRates: [{ meterKey: "vpn.unlimited.time", unitPrice: null }],
    });
    // a flat price per day through the API is not a 30-day price
    const daily: TenantPackage = { ...PKG, meterRates: [{ ...flat, unitSize: "86400" }] };
    expect(packageFormOf(daily).rates["vpn.unlimited.time"]).toBe("");
    expect(otherRates(daily)).toEqual(daily.meterRates);
  });

  it("each wholesale field has its own label, hint and list line", () => {
    for (const m of WHOLESALE_METERS) {
      expect(m.label, m.meterKey).toBeTruthy();
      expect(m.hint, m.meterKey).toBeTruthy();
      expect(m.perUnit, m.meterKey).toBeTruthy();
    }
    expect(new Set(WHOLESALE_METERS.map((m) => m.hint)).size).toBe(WHOLESALE_METERS.length);
  });
});
