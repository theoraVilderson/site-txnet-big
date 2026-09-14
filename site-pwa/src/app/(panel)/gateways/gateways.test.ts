import { describe, expect, it } from "vitest";
import type { AdminGateway } from "@/lib/billing-api";
import type { Me } from "@/lib/auth-api";
import {
  canManageLinks,
  createBody,
  emptyForm,
  formFromGateway,
  updateBody,
  validateForm,
} from "./_lib/gateway-form";
import { MAX_PRESETS, addPreset } from "./_lib/presets";

/**
 * The gateways page (F-102-d), and the part of it that has to be true without
 * a browser to look at:
 *
 * - **A secret is write-only here too.** The form never starts with one — not
 *   from the list, not from an edit — and a secret box left empty sends
 *   nothing, because an empty string sent as `merchantId` is a request to store
 *   an empty merchant id (billing refuses it, but only after the operator
 *   thought they had saved).
 * - **An edit sends only what changed.** A full body on every save would
 *   rewrite `verificationStatus` for a tenant that may not set it, and a stale
 *   form would silently undo another operator's change to a field this one
 *   never touched.
 * - **Linking is the platform owner's.** `gateway.manage` alone does not make a
 *   reseller the one who lends gateways (ADR-0041, D-31); the tenant type does.
 */

const OWNER_ME: Me = {
  userId: "u1",
  fullName: "Theora",
  role: { id: "r1", name: "SuperAdmin" },
  permissions: ["*"],
  tenant: { id: "t-owner", type: "platform_owner" },
  isImpersonated: false,
};
const RESELLER_ME: Me = { ...OWNER_ME, role: { id: "r2", name: "Admin" }, permissions: ["gateway.manage", "settlement.manage"], tenant: { id: "t-res", type: "reseller" } };

const GATEWAY: AdminGateway = {
  source: "tenant",
  id: "g1",
  tenantId: "t-res",
  displayName: "Zarinpal",
  providerName: "zarinpal",
  gatewayCategory: "domestic_rial",
  isActive: true,
  verificationStatus: "verified",
  description: null,
  supportedCurrencies: null,
  confirmationMode: null,
  minAcceptAmount: "1",
  maxAcceptAmount: "500",
  feeCalculationMode: "manual",
  feeType: "percentage",
  feeValue: "1.5",
  feeFloor: null,
  feeCeiling: null,
  useLiveRate: true,
  staticRate: null,
  percentageModifier: "0",
  fixedAmountModifier: "0",
  minRate: null,
  maxRate: null,
  roundingStep: null,
  roundingMode: "up",
  depositPresets: ["2.00", "5.00"],
  callbackUrl: null,
  credentials: {
    merchantId: { configured: true, version: 3, rotatedAt: "2026-09-13T10:00:00.000Z" },
    secretKey: { configured: false, version: null, rotatedAt: null },
  },
  createdAt: "2026-09-13T09:00:00.000Z",
  updatedAt: "2026-09-13T09:00:00.000Z",
};

describe("gateway form — secrets", () => {
  it("never starts with a secret, even when the gateway has one configured", () => {
    const form = formFromGateway({ ...GATEWAY, merchantId: "leaked-if-copied" } as AdminGateway);

    expect(form.merchantId).toBe("");
    expect(form.secretKey).toBe("");
    expect(JSON.stringify(form)).not.toContain("leaked-if-copied");
  });

  it("sends a secret only when one was typed, trimmed", () => {
    const form = { ...emptyForm("tenant"), displayName: "Stripe", providerName: "stripe", gatewayCategory: "international_card", minAcceptAmount: "1", maxAcceptAmount: "100", feeValue: "0" };

    expect(createBody(form, RESELLER_ME)).not.toHaveProperty("merchantId");
    expect(createBody(form, RESELLER_ME)).not.toHaveProperty("secretKey");
    expect(createBody({ ...form, merchantId: "  m-123 \n" }, RESELLER_ME).merchantId).toBe("m-123");
    expect(updateBody(GATEWAY, { ...formFromGateway(GATEWAY), secretKey: " sk " }, OWNER_ME)).toEqual({ secretKey: "sk" });
  });
});

describe("gateway form — what a save sends", () => {
  it("sends nothing for an untouched edit, and only the changed field otherwise", () => {
    const form = formFromGateway(GATEWAY);

    expect(updateBody(GATEWAY, form, OWNER_ME)).toEqual({});
    expect(updateBody(GATEWAY, { ...form, feeValue: "2" }, OWNER_ME)).toEqual({ feeValue: "2" });
    expect(updateBody(GATEWAY, { ...form, feeFloor: "0.5" }, OWNER_ME)).toEqual({ feeFloor: "0.5" });
    expect(updateBody({ ...GATEWAY, feeFloor: "0.5" }, { ...form, feeFloor: "" }, OWNER_ME)).toEqual({ feeFloor: null });
  });

  it("never sends verification or another tenant for a reseller, and does for the platform owner", () => {
    const form = { ...formFromGateway(GATEWAY), verificationStatus: "failed" as const };

    expect(updateBody(GATEWAY, form, RESELLER_ME)).toEqual({});
    expect(updateBody(GATEWAY, form, OWNER_ME)).toEqual({ verificationStatus: "failed" });

    const create = { ...emptyForm("tenant"), tenantId: "t-other", displayName: "X", providerName: "idpay", gatewayCategory: "domestic_rial", minAcceptAmount: "1", maxAcceptAmount: "2", feeValue: "0" };
    expect(createBody(create, RESELLER_ME)).not.toHaveProperty("tenantId");
    expect(createBody(create, OWNER_ME).tenantId).toBe("t-other");
    expect(createBody({ ...create, source: "platform" }, OWNER_ME)).not.toHaveProperty("tenantId");
  });
});

describe("gateway form — validation", () => {
  it("names each field that would be refused, before a request is made", () => {
    expect(validateForm(emptyForm("tenant"))).toEqual(
      expect.objectContaining({ displayName: "required", providerName: "required", minAcceptAmount: "required", maxAcceptAmount: "required" }),
    );
    expect(validateForm({ ...formFromGateway(GATEWAY), minAcceptAmount: "600" })).toEqual({ minAcceptAmount: "range" });
    expect(validateForm({ ...formFromGateway(GATEWAY), feeValue: "1,5" })).toEqual({ feeValue: "decimal" });
    expect(validateForm(formFromGateway(GATEWAY))).toEqual({});
  });
});

/**
 * Zarinpal's merchant id is a 36-character UUID, and Zarinpal refuses anything
 * else only at payment time (`-9`, "must be at least 36 characters") — after
 * the operator believed the gateway was set up. Named here, at the keyboard.
 */
describe("gateway form — a Zarinpal merchant id", () => {
  const base = { ...emptyForm("tenant"), displayName: "Z", providerName: "zarinpal", gatewayCategory: "domestic_rial", minAcceptAmount: "1", maxAcceptAmount: "20", feeValue: "0" };

  it("must be a UUID when one is typed", () => {
    expect(validateForm({ ...base, merchantId: "12345678" })).toEqual({ merchantId: "merchantFormat" });
    expect(validateForm({ ...base, merchantId: " 1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d " })).toEqual({});
  });

  it("may be left empty, which keeps the stored one", () => {
    expect(validateForm({ ...base, merchantId: "" })).toEqual({});
  });

  it("is not judged for another provider", () => {
    expect(validateForm({ ...base, providerName: "nowpayments", merchantId: "short-api-key" })).toEqual({});
  });
});

describe("linking gateways to tenants", () => {
  it("is offered to the platform owner only, whatever permissions a reseller holds", () => {
    expect(canManageLinks(OWNER_ME)).toBe(true);
    expect(canManageLinks(RESELLER_ME)).toBe(false);
    expect(canManageLinks(null)).toBe(false);
  });
});

/**
 * Quick amounts (F-093-k over F-092-v). A gateway's own list overrides the
 * tenant's default; empty inherits. The editor refuses what billing would, so
 * a list that looks saved is a list billing stored.
 */
describe("quick amounts", () => {
  it("adds an amount sorted and in two decimals, and refuses what billing would", () => {
    expect(addPreset(["5.00"], " 2.5 ")).toEqual({ list: ["2.50", "5.00"] });
    expect(addPreset(["2.50"], "2.5")).toEqual({ error: "duplicate" });
    expect(addPreset([], "0")).toEqual({ error: "positive" });
    expect(addPreset([], "1.005")).toEqual({ error: "decimal" });
    expect(addPreset([], "abc")).toEqual({ error: "decimal" });
    const full = Array.from({ length: MAX_PRESETS }, (_, i) => `${i + 1}.00`);
    expect(addPreset(full, "99")).toEqual({ error: "limit" });
  });

  it("starts an edit from the gateway's list and sends it only when it changed", () => {
    const form = formFromGateway(GATEWAY);
    expect(form.depositPresets).toEqual(["2.00", "5.00"]);
    expect(updateBody(GATEWAY, form, OWNER_ME)).toEqual({});
    expect(updateBody(GATEWAY, { ...form, depositPresets: ["2.00"] }, OWNER_ME)).toEqual({ depositPresets: ["2.00"] });
    expect(updateBody(GATEWAY, { ...form, depositPresets: [] }, OWNER_ME)).toEqual({ depositPresets: [] });
  });

  it("sends a new gateway's list only when one was set", () => {
    const create = { ...emptyForm("tenant"), displayName: "X", providerName: "idpay", gatewayCategory: "domestic_rial", minAcceptAmount: "1", maxAcceptAmount: "20", feeValue: "0" };
    expect(createBody(create, OWNER_ME)).not.toHaveProperty("depositPresets");
    expect(createBody({ ...create, depositPresets: ["2.00", "2.50"] }, OWNER_ME).depositPresets).toEqual(["2.00", "2.50"]);
  });
});

/** F-092-w: the callback address sent to Zarinpal, per gateway. Empty = the panel domain. */
describe("gateway form — callback address", () => {
  const base = { ...emptyForm("tenant"), displayName: "Z", providerName: "zarinpal", gatewayCategory: "domestic_rial", minAcceptAmount: "1", maxAcceptAmount: "20", feeValue: "0" };

  it("must be an absolute http(s) address when one is typed", () => {
    expect(validateForm({ ...base, callbackUrl: "pay.example.org/cb" })).toEqual({ callbackUrl: "url" });
    expect(validateForm({ ...base, callbackUrl: " https://pay.example.org/api/billing/deposit/callback " })).toEqual({});
  });

  it("is sent on create only when typed, and on edit only when changed — empty clears it", () => {
    expect(createBody(base, OWNER_ME)).not.toHaveProperty("callbackUrl");
    expect(createBody({ ...base, callbackUrl: " https://pay.example.org/cb " }, OWNER_ME).callbackUrl).toBe("https://pay.example.org/cb");

    const withUrl = { ...GATEWAY, callbackUrl: "https://pay.example.org/cb" };
    const form = formFromGateway(withUrl);
    expect(form.callbackUrl).toBe("https://pay.example.org/cb");
    expect(updateBody(withUrl, form, OWNER_ME)).toEqual({});
    expect(updateBody(withUrl, { ...form, callbackUrl: "" }, OWNER_ME)).toEqual({ callbackUrl: null });
  });
});
