import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api-error";
import type { ResellerLimitRow } from "@/lib/tenant-api";
import {
  PACKAGE_WIZARD_STEPS,
  emptyPackageWizard,
  firstInvalidStep,
  packageWizardBody,
  packageWizardErrors,
  refusalStep,
  reviewWarnings,
  type PackageWizardForm,
} from "./_lib/package-wizard";
import { WHOLESALE_METERS } from "./_lib/packages";

/**
 * The new-package wizard (PK-1-g, ADR-0154 (3)(4)). What breaks with nothing red:
 *  - **a package that sells nothing by default.** Every active platform product
 *    starts ticked, with no window and `stop`; an archived or inactive one, or
 *    a reseller's own, is never sent;
 *  - **a limit written that the owner never touched.** Each key is shown at the
 *    platform's value; only a changed one is in the body, and "no limit" is an
 *    explicit `null`, never a blank field read as one;
 *  - **a refusal that leaves the owner on the review.** The one `POST` names
 *    the field (`fieldErrors` path, PK-1-j) or a reason; the wizard returns to
 *    the step that asks it.
 */

const LIMITS = [
  { key: "end_users_max", max: 1_000_000 },
  { key: "custom_domains_max", max: 100 },
] as Pick<ResellerLimitRow, "key" | "max">[];

const PRODUCTS = [
  { id: "p-1", platform: true, isActive: true, archivedAt: null },
  { id: "p-2", platform: true, isActive: false, archivedAt: null },
  { id: "p-3", platform: false, isActive: true, archivedAt: null },
  { id: "p-4", platform: true, isActive: true, archivedAt: "2026-10-01T00:00:00Z" },
  { id: "p-5", platform: true, isActive: true, archivedAt: null },
];

const filled = (patch: Partial<PackageWizardForm> = {}): PackageWizardForm => ({
  ...emptyPackageWizard("fa", PRODUCTS),
  name: "طلایی",
  monthlyPrice: "100",
  ...patch,
});

describe("the defaults", () => {
  it("ticks every active platform product, with no window", () => {
    expect(emptyPackageWizard("fa", PRODUCTS).products).toEqual({
      "p-1": { day: "", week: "", month: "" },
      "p-5": { day: "", week: "", month: "" },
    });
  });

  it("sends each ticked product with no window and stop", () => {
    expect(packageWizardBody(filled(), LIMITS).products).toEqual([{ productId: "p-1" }, { productId: "p-5" }]);
  });

  it("writes no limit the owner left at the platform's value", () => {
    expect(packageWizardBody(filled(), LIMITS).limits).toBeUndefined();
  });
});

describe("the body is the whole package in one POST", () => {
  it("carries the source language, the description and a typed window", () => {
    const body = packageWizardBody(
      filled({ sourceLang: "en", name: " Gold ", description: " For shops ", products: { "p-1": { day: "", week: "50", month: "" } } }),
      LIMITS,
    );
    expect(body).toMatchObject({ name: "Gold", sourceLang: "en", description: "For shops", monthlyPrice: "100", includedFeatureKeys: [] });
    expect(body.products).toEqual([{ productId: "p-1", week: 50 }]);
  });

  it("leaves a blank description out", () => {
    expect("description" in packageWizardBody(filled({ description: "  " }), LIMITS)).toBe(false);
  });

  it("sends a changed limit as a number and 'no limit' as null", () => {
    const body = packageWizardBody(
      filled({ limits: { end_users_max: { typed: "500", noLimit: false }, custom_domains_max: { typed: "", noLimit: true } } }),
      LIMITS,
    );
    expect(body.limits).toEqual([
      { key: "end_users_max", value: 500 },
      { key: "custom_domains_max", value: null },
    ]);
  });
});

describe("each step is checked before the next", () => {
  it("refuses a limit over its key's bound on the limits step", () => {
    const form = filled({ limits: { custom_domains_max: { typed: "101", noLimit: false } } });
    expect(Object.keys(packageWizardErrors("limits", form, LIMITS))).toEqual(["limits.custom_domains_max"]);
    expect(firstInvalidStep(form, LIMITS)).toBe("limits");
  });

  it("refuses a window that is not a whole number on the products step", () => {
    const form = filled({ products: { "p-1": { day: "1.5", week: "", month: "" } } });
    expect(Object.keys(packageWizardErrors("products", form, LIMITS))).toEqual(["products.p-1"]);
  });

  it("finds the first step a filled form still fails", () => {
    expect(firstInvalidStep(filled({ name: "" }), LIMITS)).toBe("names");
    expect(firstInvalidStep(filled({ monthlyPrice: "" }), LIMITS)).toBe("prices");
    expect(firstInvalidStep(filled(), LIMITS)).toBeNull();
  });
});

describe("a refusal returns to its step", () => {
  const refused = (reason: string | undefined, path?: string) =>
    new ApiError("refused", { status: 422, reason, fieldErrors: path ? [{ path, message: "x" }] : [] });

  it("follows the field the service named", () => {
    expect(refusalStep(refused("limit_out_of_range", "limits.0.value"))).toBe("limits");
    expect(refusalStep(refused("amount_finer_than_currency", "products.1.overage.unitPrice"))).toBe("products");
    expect(refusalStep(refused(undefined, "monthlyPrice"))).toBe("prices");
  });

  it("follows the reason when no field is named", () => {
    expect(refusalStep(refused("package_name_taken"))).toBe("names");
    expect(refusalStep(refused("meter_not_found"))).toBe("rates");
    expect(refusalStep(refused("texts_unavailable"))).toBeNull();
  });
});

describe("the review warns in words", () => {
  it("names a package that sells no product, and every blank wholesale rate", () => {
    const warnings = reviewWarnings(filled({ products: {} }));
    expect(warnings).toHaveLength(1 + WHOLESALE_METERS.length);
    expect(new Set(warnings).size).toBe(warnings.length);
  });

  it("is silent once products are listed and every rate is priced", () => {
    const rates = Object.fromEntries(WHOLESALE_METERS.map((m) => [m.meterKey, "1"])) as PackageWizardForm["rates"];
    expect(reviewWarnings(filled({ rates }))).toEqual([]);
  });
});

it("asks in ADR-0154 (3)'s order", () => {
  expect(PACKAGE_WIZARD_STEPS).toEqual(["names", "prices", "features", "products", "limits", "rates", "review"]);
});
