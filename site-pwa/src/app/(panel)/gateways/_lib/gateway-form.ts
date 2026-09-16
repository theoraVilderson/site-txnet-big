import type { Me } from "@/lib/auth-api";
import type { AdminGateway, CreateGatewayBody, GatewaySource, UpdateGatewayBody } from "@/lib/billing-api";
import { samePresets } from "./presets";
import { PROVIDER_FIELDS, secretFields, takesStaticRate, type Provider } from "./provider-fields";

/** The values billing's enums accept. Shown as they are: a provider name is a logo, not a sentence. */
export const PROVIDERS = Object.keys(PROVIDER_FIELDS) as Provider[];
export const CATEGORIES = ["domestic_rial", "international_card", "crypto", "in_chat"] as const;
export const FEE_MODES = ["manual", "automatic"] as const;
export const FEE_TYPES = ["percentage", "fixed"] as const;
export const VERIFICATION = ["pending_test_transaction", "verified", "failed"] as const;

/**
 * What the form holds: every field a string (or a boolean), exactly as typed.
 * Conversion happens once, in {@link createBody} / {@link updateBody}.
 *
 * `merchantId`, `secretKey` and `webhookSecret` are the only place a secret exists in this app,
 * and only between a keystroke and a save. Nothing ever fills them.
 */
export interface GatewayForm {
  source: GatewaySource;
  /** A tenant row's owner. Empty means the caller's own tenant; only the platform owner may name another. */
  tenantId: string;
  displayName: string;
  providerName: string;
  gatewayCategory: string;
  isActive: boolean;
  minAcceptAmount: string;
  maxAcceptAmount: string;
  feeCalculationMode: string;
  feeType: string;
  feeValue: string;
  feeFloor: string;
  feeCeiling: string;
  /** `""` when the row has none (a platform gateway) or the caller may not set it. */
  verificationStatus: string;
  merchantId: string;
  secretKey: string;
  webhookSecret: string;
  /** A Telegram Stars gateway's USD value per Star (F-104-f); ignored for any other provider. */
  staticRate: string;
  /** This gateway's own quick amounts, as `addPreset` keeps them; empty inherits the tenant's default. */
  depositPresets: string[];
  /** The callback address sent to the provider; empty = the tenant's panel domain (F-092-w). */
  callbackUrl: string;
}

export type FormError = "required" | "decimal" | "range" | "merchantFormat" | "url";
export type FormErrors = Partial<Record<keyof GatewayForm, FormError>>;

const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,8})?$/;
/** An absolute http(s) address — what billing stores as a callback. */
function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** A Zarinpal merchant id: 36 characters, 8-4-4-4-12 hex. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIRED = ["displayName", "providerName", "gatewayCategory"] as const;
const DECIMALS = ["minAcceptAmount", "maxAcceptAmount", "feeValue", "feeFloor", "feeCeiling"] as const;
/** Empty is sent as `null`: no fee floor or ceiling, and no minimum or maximum amount. */
const NULLABLE = new Set<keyof GatewayForm>(["feeFloor", "feeCeiling", "minAcceptAmount", "maxAcceptAmount"]);
/** Every field an edit may send, secrets and verification aside — they have rules of their own below. */
const EDITABLE = [
  "displayName",
  "providerName",
  "gatewayCategory",
  "isActive",
  "minAcceptAmount",
  "maxAcceptAmount",
  "feeCalculationMode",
  "feeType",
  "feeValue",
  "feeFloor",
  "feeCeiling",
] as const;

/** Only the platform owner links gateways, verifies them, or manages another tenant's (D-31). */
export const isPlatformOwner = (me: Me | null | undefined) => me?.tenant.type === "platform_owner";
export const canManageLinks = (me: Me | null | undefined) => isPlatformOwner(me);

export function emptyForm(source: GatewaySource): GatewayForm {
  return {
    source,
    tenantId: "",
    displayName: "",
    providerName: "",
    gatewayCategory: "",
    isActive: false,
    minAcceptAmount: "",
    maxAcceptAmount: "",
    feeCalculationMode: "manual",
    feeType: "percentage",
    feeValue: "0",
    feeFloor: "",
    feeCeiling: "",
    verificationStatus: "",
    merchantId: "",
    secretKey: "",
    webhookSecret: "",
    staticRate: "",
    depositPresets: [],
    callbackUrl: "",
  };
}

/**
 * A gateway as the form edits it. Picked field by field, so nothing billing
 * answered — and certainly nothing it should not have — is carried into state
 * the form later serialises.
 */
export function formFromGateway(g: AdminGateway): GatewayForm {
  return {
    source: g.source,
    tenantId: g.tenantId ?? "",
    displayName: g.displayName,
    providerName: g.providerName,
    gatewayCategory: g.gatewayCategory,
    isActive: g.isActive,
    minAcceptAmount: g.minAcceptAmount ?? "",
    maxAcceptAmount: g.maxAcceptAmount ?? "",
    feeCalculationMode: g.feeCalculationMode,
    feeType: g.feeType,
    feeValue: g.feeValue,
    feeFloor: g.feeFloor ?? "",
    feeCeiling: g.feeCeiling ?? "",
    verificationStatus: g.verificationStatus ?? "",
    merchantId: "",
    secretKey: "",
    webhookSecret: "",
    staticRate: g.staticRate ?? "",
    depositPresets: [...(g.depositPresets ?? [])],
    callbackUrl: g.callbackUrl ?? "",
  };
}

/** Each field that billing would refuse, named before a request is made. Billing still decides. */
export function validateForm(form: GatewayForm): FormErrors {
  const errors: FormErrors = {};
  for (const k of REQUIRED) if (form[k].trim() === "") errors[k] = "required";
  // An automatic fee is the provider's quote; the stored value is never read.
  if (form.feeCalculationMode === "manual" && form.feeValue.trim() === "") errors.feeValue = "required";
  for (const k of DECIMALS) {
    const v = form[k].trim();
    if (v !== "" && !errors[k] && !DECIMAL.test(v)) errors[k] = "decimal";
  }
  const pair = (lo: "minAcceptAmount" | "feeFloor", hi: "maxAcceptAmount" | "feeCeiling") => {
    if (errors[lo] || errors[hi] || form[lo].trim() === "" || form[hi].trim() === "") return;
    if (Number(form[lo]) > Number(form[hi])) errors[lo] = "range";
  };
  pair("minAcceptAmount", "maxAcceptAmount");
  pair("feeFloor", "feeCeiling");
  // Zarinpal refuses any other shape only at payment time (`-9`), long after the
  // operator believed the gateway was ready. An empty box keeps the stored id.
  const merchantId = form.merchantId.trim();
  if (form.providerName === "zarinpal" && merchantId && !UUID.test(merchantId)) errors.merchantId = "merchantFormat";
  if (takesStaticRate(form.providerName)) {
    const rate = form.staticRate.trim();
    if (rate === "" || (DECIMAL.test(rate) && Number(rate) <= 0)) errors.staticRate = "required";
    else if (!DECIMAL.test(rate)) errors.staticRate = "decimal";
  }
  if (form.callbackUrl.trim() && !isWebAddress(form.callbackUrl.trim())) errors.callbackUrl = "url";
  return errors;
}

function value(form: GatewayForm, k: (typeof EDITABLE)[number]): string | boolean | null {
  const v = form[k];
  if (typeof v === "boolean") return v;
  const trimmed = v.trim();
  return NULLABLE.has(k) && trimmed === "" ? null : trimmed;
}

/** The secrets typed for the chosen provider's own fields. A box another provider left filled is not sent. */
function secrets(form: GatewayForm): Pick<UpdateGatewayBody, "merchantId" | "secretKey" | "webhookSecret"> {
  const out: Pick<UpdateGatewayBody, "merchantId" | "secretKey" | "webhookSecret"> = {};
  for (const { slot } of secretFields(form.providerName)) {
    const v = form[slot].trim();
    if (v) out[slot] = v;
  }
  return out;
}

export function createBody(form: GatewayForm, me: Me | null): CreateGatewayBody {
  const body: Record<string, unknown> = { source: form.source };
  for (const k of EDITABLE) {
    const v = value(form, k);
    if (v !== null) body[k] = v;
  }
  if (isPlatformOwner(me) && form.source === "tenant") {
    if (form.tenantId.trim()) body.tenantId = form.tenantId.trim();
    if (form.verificationStatus) body.verificationStatus = form.verificationStatus;
  }
  // Billing requires a fee value; an automatic-fee gateway left it empty.
  if (body.feeValue === undefined || body.feeValue === "") body.feeValue = "0";
  if (form.depositPresets.length > 0) body.depositPresets = form.depositPresets;
  if (form.callbackUrl.trim()) body.callbackUrl = form.callbackUrl.trim();
  // A Star has no live rate: its value is the operator's (D-32).
  if (takesStaticRate(form.providerName)) Object.assign(body, { staticRate: form.staticRate.trim(), useLiveRate: false });
  return { ...(body as unknown as CreateGatewayBody), ...secrets(form) };
}

/** Only what changed since `original` was loaded, plus any secret typed. An untouched form sends `{}`. */
export function updateBody(original: AdminGateway, form: GatewayForm, me: Me | null): UpdateGatewayBody {
  const before = formFromGateway(original);
  const body: Record<string, unknown> = {};
  for (const k of EDITABLE) {
    // An emptied fee value (automatic mode) keeps the stored one rather than sending "".
    if (k === "feeValue" && form.feeValue.trim() === "") continue;
    if (form[k] !== before[k]) body[k] = value(form, k);
  }
  if (
    isPlatformOwner(me) &&
    original.source === "tenant" &&
    form.verificationStatus !== "" &&
    form.verificationStatus !== before.verificationStatus
  ) {
    body.verificationStatus = form.verificationStatus;
  }
  if (!samePresets(form.depositPresets, before.depositPresets)) body.depositPresets = form.depositPresets;
  if (form.callbackUrl.trim() !== before.callbackUrl.trim()) body.callbackUrl = form.callbackUrl.trim() || null;
  if (takesStaticRate(form.providerName)) {
    if (form.staticRate.trim() !== before.staticRate.trim()) body.staticRate = form.staticRate.trim();
    if (original.useLiveRate !== false) body.useLiveRate = false;
  }
  return { ...(body as UpdateGatewayBody), ...secrets(form) };
}

/** The fields a save would send, in the order it sends them — the edit screen's list of changes. */
export function changedFields(original: AdminGateway, form: GatewayForm, me: Me | null): (keyof GatewayForm)[] {
  return Object.keys(updateBody(original, form, me)) as (keyof GatewayForm)[];
}
