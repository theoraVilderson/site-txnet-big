import { describe, expect, it } from "vitest";

import type { ResellerLimitRow, TenantPackage } from "@/lib/tenant-api";
import { panelResellerPackagePath, PANEL_RESELLER_PACKAGES } from "@/lib/routes";
import { packageFormOf } from "./_lib/packages";
import { packageLimitsOf, sectionBody, sectionErrors, sellsNothing } from "./_lib/package-page";

/**
 * One package's page (PK-1-f, ADR-0154 (2)(8)). What breaks with nothing red:
 *  - **a section's sheet sending another section's field.** Each sheet edits its
 *    own part over `PATCH /tenant-packages/:id`; a price sent from the features
 *    sheet is a subscriber's period repriced by a click that never showed it;
 *  - **a limit read as the package's when it is the platform's.** A package
 *    with no row of its own inherits the platform's number; the page says
 *    which, so "no limit" on the package is never mistaken for "not set";
 *  - **a package that sells nothing passing unflagged.** A reseller sells only
 *    the products its package lists (ADR-0107 point 3).
 */
const PKG: TenantPackage = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Gold",
  nameKey: "packages.p_11111111111141118111111111111111.name",
  descriptionKey: null,
  sourceLang: "en",
  monthlyPrice: "10.00",
  yearlyPrice: null,
  currencyCode: "USD",
  includedFeatureKeys: ["spin_wheel"],
  isActive: true,
  meterRates: [],
  productCount: 2,
};

const row = (over: Partial<ResellerLimitRow>): ResellerLimitRow => ({
  key: "custom_domains_max",
  kind: "guard",
  codeDefault: 3,
  max: 100,
  platform: null,
  packages: [],
  resellers: [],
  overage: null,
  ...over,
});

describe("a section's sheet sends its own fields and no other", () => {
  it("the features sheet sends the features, even with a price typed into the form", () => {
    const form = { ...packageFormOf(PKG), featureKeys: ["spin_wheel", "coupon_engine"], monthlyPrice: "99" };
    expect(sectionBody(PKG, form, "features")).toEqual({ includedFeatureKeys: ["spin_wheel", "coupon_engine"] });
  });

  it("the basics sheet sends a cleared price as null, and nothing when nothing changed", () => {
    const form = { ...packageFormOf(PKG), yearlyPrice: "100", monthlyPrice: "" };
    expect(sectionBody(PKG, form, "basics")).toEqual({ monthlyPrice: null, yearlyPrice: "100" });
    expect(sectionBody(PKG, packageFormOf(PKG), "basics")).toBeNull();
  });

  it("a section shows only its own errors", () => {
    const form = { ...packageFormOf(PKG), name: "", monthlyPrice: "", yearlyPrice: "" };
    expect(Object.keys(sectionErrors(form, "basics")).sort()).toEqual(["monthlyPrice", "name"]);
    expect(sectionErrors(form, "features")).toEqual({});
  });
});

describe("a limit says whose it is", () => {
  it("the package's own value beside the platform's, the code's default when the platform has none", () => {
    const table = [
      row({ platform: { value: 5 }, packages: [{ packageId: PKG.id, name: "Gold", value: null }] }),
      row({ key: "staff_members_max", codeDefault: null }),
    ];
    expect(packageLimitsOf(table, PKG.id)).toEqual([
      { key: "custom_domains_max", kind: "guard", max: 100, own: null, platform: 5, overage: null },
      { key: "staff_members_max", kind: "guard", max: 100, own: undefined, platform: null, overage: null },
    ]);
  });

  it("a quota carries its answer past it — the package's beside the platform's; another package's is not this one's", () => {
    const priced = { mode: "overage" as const, unitPrice: "0.10", currencyCode: "USD" };
    const table = [
      row({
        key: "campaign_sends_daily_max",
        kind: "quota",
        overage: { platform: { mode: "stop", unitPrice: null, currencyCode: null }, packages: [{ ...priced, packageId: "other", name: "Silver" }], resellers: [] },
      }),
    ];
    expect(packageLimitsOf(table, PKG.id)[0].overage).toEqual({ own: undefined, platform: { mode: "stop", unitPrice: null, currencyCode: null } });
  });
});

describe("a package listing no product is flagged (ADR-0154 (8))", () => {
  it("by its product count", () => {
    expect(sellsNothing({ productCount: 0 })).toBe(true);
    expect(sellsNothing(PKG)).toBe(false);
  });

  it("its page is under the packages page", () => {
    expect(panelResellerPackagePath(PKG.id)).toBe(`${PANEL_RESELLER_PACKAGES}/${PKG.id}`);
  });
});
