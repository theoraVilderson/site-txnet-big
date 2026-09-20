import { describe, expect, it } from "vitest";
import { emptyForm } from "./_lib/gateway-form";
import { WIZARD_STEPS, applyProvider, feePreview, firstInvalidStep, stepErrors } from "./_lib/gateway-wizard";

/**
 * The add-gateway wizard (F-102-e). The screens are only a walk through the
 * same form `gateway-form.ts` validates and serialises; what has to hold here:
 *
 * - **A step blocks only on its own fields.** "Next" on the provider step must
 *   not complain about a fee the operator has not reached yet.
 * - **Picking a provider fills what it implies** (category, a display name) but
 *   never overwrites what the operator already typed.
 * - **The fee preview is billing's formula**, in exact decimals: a float preview
 *   that says 1.5% of 0.1 is 0.0015000000000000002 is a preview nobody trusts,
 *   and one that stops at 0.0015 where billing charges 0.01 is no better.
 */

describe("gateway wizard", () => {
  it("names five steps, secrets before review", () => {
    expect(WIZARD_STEPS.map((s) => s.id)).toEqual(["provider", "details", "fee", "secrets", "review"]);
  });

  it("blocks a step only on its own fields", () => {
    const form = emptyForm("tenant");
    expect(Object.keys(stepErrors(form, "provider"))).toEqual(["providerName"]);
    expect(stepErrors(form, "provider").feeValue).toBeUndefined();
    const picked = applyProvider(form, "zarinpal");
    expect(stepErrors(picked, "provider")).toEqual({});
    // An amount range is optional: a picked provider already fills everything the details step needs.
    expect(stepErrors(picked, "details")).toEqual({});
  });

  it("finds the first step with an error, for the review step's submit", () => {
    const form = { ...applyProvider(emptyForm("tenant"), "idpay"), minAcceptAmount: "10", maxAcceptAmount: "5" };
    expect(firstInvalidStep(form)).toBe("details");
    expect(firstInvalidStep({ ...form, maxAcceptAmount: "50" })).toBeNull();
  });

  it("fills category and name from the provider, keeping what was typed", () => {
    const filled = applyProvider(emptyForm("tenant"), "nowpayments");
    expect(filled.gatewayCategory).toBe("crypto");
    expect(filled.displayName).toBe("NOWPayments");
    const typed = applyProvider({ ...emptyForm("tenant"), displayName: "My crypto" }, "stripe");
    expect(typed.displayName).toBe("My crypto");
    expect(typed.gatewayCategory).toBe("international_card");
    // Switching provider replaces a name the wizard itself suggested.
    expect(applyProvider(filled, "zarinpal").displayName).toBe("Zarinpal");
  });

  it("previews the fee exactly as billing computes it", () => {
    const base = { ...emptyForm("tenant"), feeCalculationMode: "manual" };
    expect(feePreview({ ...base, feeType: "percentage", feeValue: "1.5" }, "0.1")).toBe("0.01");
    expect(feePreview({ ...base, feeType: "percentage", feeValue: "2" }, "100")).toBe("2");
    expect(feePreview({ ...base, feeType: "fixed", feeValue: "0.3" }, "100")).toBe("0.3");
    expect(feePreview({ ...base, feeType: "percentage", feeValue: "1", feeFloor: "0.5" }, "10")).toBe("0.5");
    expect(feePreview({ ...base, feeType: "percentage", feeValue: "10", feeCeiling: "3" }, "100")).toBe("3");
    expect(feePreview({ ...base, feeCalculationMode: "automatic" }, "100")).toBeNull();
    expect(feePreview({ ...base, feeValue: "abc" }, "100")).toBeNull();
  });

  it("rounds the fee up to the cent, as billing's feeOf does", () => {
    const base = { ...emptyForm("tenant"), feeCalculationMode: "manual", feeType: "percentage" };
    // `gateway-pricing.ts` rounds the fee up to the cent and *then* clamps it, so a
    // preview that keeps the tail shows a cent less than the payer is charged.
    expect(feePreview({ ...base, feeValue: "12.3" }, "1")).toBe("0.13");
    // A fee under a cent still costs a cent.
    expect(feePreview({ ...base, feeValue: "0.1" }, "1")).toBe("0.01");
    // Already whole cents are left alone, and a fixed fee is rounded the same way.
    expect(feePreview({ ...base, feeValue: "2.5" }, "100")).toBe("2.5");
    expect(feePreview({ ...base, feeType: "fixed", feeValue: "0.301" }, "100")).toBe("0.31");
    // The floor and the ceiling bind the rounded fee, not the raw one.
    expect(feePreview({ ...base, feeValue: "12.3", feeCeiling: "0.12" }, "1")).toBe("0.12");
    expect(feePreview({ ...base, feeValue: "12.3", feeFloor: "0.5" }, "1")).toBe("0.5");
    // Zero is not raised to a cent: nothing is charged, so there is nothing to round.
    expect(feePreview({ ...base, feeValue: "0" }, "100")).toBe("0");
  });
});
