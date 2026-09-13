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

describe("linking gateways to tenants", () => {
  it("is offered to the platform owner only, whatever permissions a reseller holds", () => {
    expect(canManageLinks(OWNER_ME)).toBe(true);
    expect(canManageLinks(RESELLER_ME)).toBe(false);
    expect(canManageLinks(null)).toBe(false);
  });
});
