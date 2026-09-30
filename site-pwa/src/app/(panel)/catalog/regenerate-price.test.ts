/**
 * A priced new link (F-118-r, D-58, ADR-0105 (7)): the seller writes a
 * `vpn.config.regenerate` card on the variant form, the platform owner prices
 * it wholesale on the package form, and the user sees what pressing costs.
 *
 * What would break silently:
 *  - **the card billing serves**: one link per unit, the included count, then
 *    metered at a price above zero or stopped after at least one — any other
 *    shape is refused by billing's checks, not by the form;
 *  - **the card in effect is per meter**: a regenerate card never reads as the
 *    traffic rate, and a traffic card never as the regenerate price;
 *  - **a priced Grant is never capped**: on a Grant sold with a regenerate
 *    meter the door decides (F-118-h), so the old count cap must not disable
 *    the button, and what the user reads is the free ones left or the price;
 *  - **a reseller can sell it**: the package form prices the meter wholesale,
 *    or every sale of a reseller variant with the card is `wholesale_rate_missing`.
 */
import type { CatalogRateCard } from "@/lib/catalog-api";
import type { RegenerateTerms } from "@/lib/billing-api";
import {
  CONFIG_REGENERATE,
  VPN_TRAFFIC,
  currentRateCard,
  regenerateCardBody,
  validateRegenerateCardForm,
  type RegenerateCardForm,
} from "./_lib/catalog-form";
import { regenerateOffer } from "../services/_lib/service-configs";
import { WHOLESALE_METERS } from "../resellers/_lib/packages";

const TODAY = "2026-09-30";
const form = (over: Partial<RegenerateCardForm> = {}): RegenerateCardForm => ({ mode: "prepaid", included: "2", after: "metered", unitPrice: "0.5", day: "", ...over });

describe("the seller's regenerate card (F-118-r)", () => {
  it("is one link per unit: included, then metered at the price", () => {
    expect(regenerateCardBody(form(), TODAY)).toEqual({
      meterKey: CONFIG_REGENERATE,
      unitSize: "1",
      unitPrice: "0.5",
      mode: "prepaid",
      includedQuantity: "2",
      afterIncluded: "metered",
    });
  });

  it("stops after the included ones with no price, and starts on a later day's first Tehran instant", () => {
    expect(regenerateCardBody(form({ after: "stop", unitPrice: "", included: "3", day: "2026-10-02" }), TODAY)).toEqual({
      meterKey: CONFIG_REGENERATE,
      unitSize: "1",
      unitPrice: "0",
      mode: "prepaid",
      includedQuantity: "3",
      afterIncluded: "stop",
      effectiveFrom: "2026-10-02T00:00:00+03:30",
    });
  });

  it("reads a blank included count as none free", () => {
    expect(regenerateCardBody(form({ included: " " }), TODAY).includedQuantity).toBe("0");
  });

  it("refuses what billing would: no price on a metered card, nothing included on a stop card, a count that is not whole, a past day", () => {
    expect(validateRegenerateCardForm(form(), TODAY)).toEqual({});
    expect(Object.keys(validateRegenerateCardForm(form({ unitPrice: "0" }), TODAY))).toEqual(["unitPrice"]);
    expect(Object.keys(validateRegenerateCardForm(form({ after: "stop", included: "0", unitPrice: "" }), TODAY))).toEqual(["included"]);
    expect(Object.keys(validateRegenerateCardForm(form({ included: "1.5" }), TODAY))).toEqual(["included"]);
    expect(Object.keys(validateRegenerateCardForm(form({ day: "2026-09-29" }), TODAY))).toEqual(["day"]);
  });

  it("finds the card in effect per meter", () => {
    const card = (meterKey: string, id: string, effectiveFrom: string): CatalogRateCard => ({
      id,
      variantId: "v",
      meterKey,
      unitSize: "1",
      unitPrice: "1",
      currencyCode: "USD",
      mode: "prepaid",
      includedQuantity: "0",
      afterIncluded: "metered",
      effectiveFrom,
      isActive: true,
    });
    const cards = [card(VPN_TRAFFIC, "t", "2026-09-01T00:00:00Z"), card(CONFIG_REGENERATE, "r", "2026-09-02T00:00:00Z")];
    const now = new Date("2026-09-30T00:00:00Z");
    expect(currentRateCard(cards, now)?.id).toBe("t");
    expect(currentRateCard(cards, now, CONFIG_REGENERATE)?.id).toBe("r");
    expect(currentRateCard([cards[0]], now, CONFIG_REGENERATE)).toBeNull();
  });
});

describe("what a new link costs the user (F-118-r)", () => {
  const terms = (over: Partial<RegenerateTerms> = {}): RegenerateTerms => ({
    unitSize: "1",
    unitPrice: "0.50000000",
    currencyCode: "USD",
    mode: "prepaid",
    includedQuantity: "2",
    afterIncluded: "metered",
    used: "0",
    ...over,
  });
  const row = { regenerateUsedCount: 3, maxRegenerateCount: 3 };

  it("keeps the count cap on a Grant sold without a price", () => {
    expect(regenerateOffer(null, row)).toEqual({ kind: "capped", left: 0, max: 3, disabled: true });
    expect(regenerateOffer(null, { regenerateUsedCount: 1, maxRegenerateCount: 3 })).toEqual({ kind: "capped", left: 2, max: 3, disabled: false });
  });

  it("names the free ones left, whatever the cap says", () => {
    expect(regenerateOffer(terms({ used: "1" }), row)).toEqual({ kind: "free", left: 1, disabled: false });
  });

  it("names the price once the free ones are spent", () => {
    expect(regenerateOffer(terms({ used: "2" }), row)).toEqual({ kind: "priced", price: "0.50000000", currencyCode: "USD", per: 1, disabled: false });
  });

  it("says none are left, and disables the button, on a card that stops", () => {
    expect(regenerateOffer(terms({ used: "2", afterIncluded: "stop" }), row)).toEqual({ kind: "none", disabled: true });
  });
});

describe("the wholesale price of a new link (F-118-r)", () => {
  it("is a package meter, one use per unit", () => {
    expect(WHOLESALE_METERS.find((m) => m.meterKey === CONFIG_REGENERATE)?.unitSize).toBe(1);
  });
});
