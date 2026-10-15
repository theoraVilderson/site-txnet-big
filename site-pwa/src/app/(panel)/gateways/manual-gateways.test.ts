import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-error";
import type { AdminGateway, ManualDestination } from "@/lib/billing-api";
import { bankOfCard, isLuhnValid } from "../_components/transfer/banks";
import { transferKind } from "../_components/transfer/transfer-kinds";
import { createBody, emptyForm, formFromGateway, updateBody, validateForm } from "./_lib/gateway-form";
import { applyKind, applyProvider } from "./_lib/gateway-wizard";
import { destinationBody, destinationErrors, destinationFormOf, emptyDestinationForm, refusalsOf } from "./_lib/destination-form";

/**
 * Setting up a manual gateway on `/gateways` (F-803-g, panel-web/contract.manual-transfer.md "Admin").
 *
 * The invariant: **what the panel sends is what billing's manual rules
 * accept, and a refusal lands on the field it names.** A manual gateway is
 * provider `manual_transfer` + category `manual` + a `manual` body, together
 * or `manual_setting_mismatch`; it is confirmed by a person until a watcher
 * exists; a card the seller mistyped is caught before a payer sends money to
 * it; and the bank is billing's to derive, so the panel never sends one that
 * disagrees with the number.
 */

// The kinds' editors are components; the locale store behind them reads the server catalog.
vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t: (_ns: string, key: string) => key, lang: "en" }) }));

const CARD = transferKind("card_to_card");
const WALLET = transferKind("crypto_wallet");
const MELLI = "6037991234567893";

const manualForm = () => applyKind(emptyForm("tenant"), CARD, { suggested: "Card", previous: null });

describe("a manual gateway's form (F-803-g)", () => {
  it("picks provider, category and the kind's default proof together, and a fee the seller sets", () => {
    const form = manualForm();
    expect(form).toMatchObject({ providerName: "manual_transfer", gatewayCategory: "manual", manualKind: "card_to_card", feeCalculationMode: "manual", displayName: "Card" });
    expect(form.requiredProof).toEqual([...CARD.defaultProof]);
  });

  it("sends the manual body whole on create, confirmed by a person", () => {
    const body = createBody({ ...manualForm(), windowMinutes: "45" }, null);
    expect(body.manual).toEqual({
      kind: "card_to_card",
      confirmationMode: "manual_admin_required",
      requiredProof: [...CARD.defaultProof],
      windowMinutes: 45,
      confirmWithinMinutes: null,
    });
    expect(body).not.toHaveProperty("merchantId");
  });

  it("refuses no proof and a window outside 10..1440 before a request", () => {
    expect(validateForm({ ...manualForm(), requiredProof: [] }).requiredProof).toBe("required");
    expect(validateForm({ ...manualForm(), windowMinutes: "9" }).windowMinutes).toBe("window");
    expect(validateForm({ ...manualForm(), windowMinutes: "1441" }).windowMinutes).toBe("window");
    expect(validateForm({ ...manualForm(), windowMinutes: "1440" }).windowMinutes).toBeUndefined();
  });

  it("takes the usual confirmation time as optional whole minutes, 1..1440 (F-803-l)", () => {
    expect(validateForm({ ...manualForm(), confirmWithinMinutes: "" }).confirmWithinMinutes).toBeUndefined();
    expect(validateForm({ ...manualForm(), confirmWithinMinutes: "0" }).confirmWithinMinutes).toBe("confirmWithin");
    expect(validateForm({ ...manualForm(), confirmWithinMinutes: "1441" }).confirmWithinMinutes).toBe("confirmWithin");
    expect(validateForm({ ...manualForm(), confirmWithinMinutes: "2.5" }).confirmWithinMinutes).toBe("confirmWithin");
    expect(createBody({ ...manualForm(), confirmWithinMinutes: " 20 " }, null).manual?.confirmWithinMinutes).toBe(20);
  });

  it("leaves the manual fields out of an online gateway entirely", () => {
    const form = applyProvider(manualForm(), "zarinpal");
    expect(form.manualKind).toBe("");
    expect(createBody({ ...form, displayName: "Z" }, null)).not.toHaveProperty("manual");
  });

  it("sends only the changed setting keys on edit, and nothing when proof was only re-ticked in another order", () => {
    const g: AdminGateway = {
      source: "tenant",
      id: "g1",
      tenantId: "t1",
      displayName: "Card",
      providerName: "manual_transfer",
      gatewayCategory: "manual",
      isActive: true,
      blocked: null,
      description: null,
      supportedCurrencies: null,
      confirmationMode: "manual_admin_required",
      minAcceptAmount: null,
      maxAcceptAmount: null,
      feeCalculationMode: "manual",
      feeType: "percentage",
      feeValue: "0",
      feeFloor: null,
      feeCeiling: null,
      useLiveRate: true,
      staticRate: null,
      percentageModifier: null,
      fixedAmountModifier: null,
      minRate: null,
      maxRate: null,
      roundingStep: null,
      roundingMode: null,
      depositPresets: [],
      callbackUrl: null,
      taxRatePercent: null,
      currencyCode: "USD",
      credentials: null,
      missingSecrets: null,
      createdAt: "2026-10-15T00:00:00Z",
      updatedAt: "2026-10-15T00:00:00Z",
      userGroupIds: [],
      manual: { kind: "card_to_card", confirmationMode: "manual_admin_required", requiredProof: ["receiptImage", "trackingCode"], windowMinutes: 30, confirmWithinMinutes: 15, destinations: 1, activeDestinations: 1 },
    };
    const form = formFromGateway(g);
    expect(updateBody(g, { ...form, requiredProof: ["trackingCode", "receiptImage"] }, null)).toEqual({});
    expect(updateBody(g, { ...form, windowMinutes: "60" }, null)).toEqual({ manual: { windowMinutes: 60 } });
    expect(form.confirmWithinMinutes).toBe("15");
    expect(updateBody(g, { ...form, confirmWithinMinutes: "30" }, null)).toEqual({ manual: { confirmWithinMinutes: 30 } });
    // Emptied, it is cleared — the payer then sees no figure.
    expect(updateBody(g, { ...form, confirmWithinMinutes: "" }, null)).toEqual({ manual: { confirmWithinMinutes: null } });
  });
});

describe("a destination (F-803-g)", () => {
  it("tells the issuing bank from the first six digits, and `other` for a BIN in no row", () => {
    expect(bankOfCard(MELLI)).toBe("melli");
    expect(bankOfCard("60379")).toBe("other");
    expect(bankOfCard("9999990000111126")).toBe("other");
  });

  it("catches a mistyped card by Luhn, as billing's `checksum`", () => {
    expect(isLuhnValid(MELLI)).toBe(true);
    const typo = { ...emptyDestinationForm(CARD), label: "Main", fields: { cardNumber: "6037991234567894", holderName: "Ali" } };
    expect(destinationErrors(typo, CARD).fields.cardNumber).toBe("checksum");
  });

  it("sends the kind's fields, drops a blank optional one, and leaves the bank to billing", () => {
    const stored = { id: "d1", label: "Main", fields: { cardNumber: MELLI, holderName: "Ali", bankId: "melli" }, isActive: true, sortOrder: 0, weight: 1, dailyCapMinor: null } as unknown as ManualDestination;
    const form = destinationFormOf(stored, CARD);
    expect(form.fields).not.toHaveProperty("bankId");
    expect(destinationBody({ ...form, fields: { ...form.fields, sheba: "  " } }, CARD)).toEqual({
      label: "Main",
      fields: { cardNumber: MELLI, holderName: "Ali" },
      isActive: true,
      weight: 1,
      dailyCapMinor: null,
    });
  });

  it("asks a wallet for its asset, network, address and decimals — nothing preset", () => {
    const errors = destinationErrors({ ...emptyDestinationForm(WALLET), label: "USDT" }, WALLET).fields;
    expect(Object.keys(errors).sort()).toEqual(["address", "asset", "decimals", "network"]);
  });

  it("puts billing's `invalid_destination` refusals on the fields they name, and nothing else", () => {
    const refused = new ApiError("x", { status: 400, reason: "invalid_destination", facts: { cardNumber: "checksum", sheba: "invalid" } });
    expect(refusalsOf(refused)).toEqual({ cardNumber: "checksum", sheba: "invalid" });
    expect(refusalsOf(new ApiError("x", { status: 409, reason: "kind_in_use" }))).toBeNull();
  });
});
