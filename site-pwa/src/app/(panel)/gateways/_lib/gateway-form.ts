import type { Me } from "@/lib/auth-api";
import type { AdminGateway, CreateGatewayBody, GatewaySource, UpdateGatewayBody } from "@/lib/billing-api";
import { CONFIRM_WITHIN_MINUTES, CONFIRMED_BY_PERSON, isManualProvider, WINDOW_MINUTES, type ManualSettingBody } from "@/lib/billing/manual-transfer";
import { samePresets } from "./presets";
import { PROVIDER_FIELDS, secretFields, takesStaticRate, type Provider } from "./provider-fields";
import { isPlatformTenant } from "@/lib/tenant-type";
import { MONEY_MAX_PLACES } from "../../_lib/money";

/** The values billing's enums accept. Shown as they are: a provider name is a logo, not a sentence. */
export const PROVIDERS = Object.keys(PROVIDER_FIELDS) as Provider[];
export const CATEGORIES = ["domestic_rial", "international_card", "crypto", "in_chat"] as const;

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
  /**
   * The platform owner's block on a tenant gateway (F-104-ak): `""` is not
   * blocked. Sent by an edit only, and only by the platform owner.
   */
  blockedReason: string;
  merchantId: string;
  secretKey: string;
  webhookSecret: string;
  /** A Telegram Stars gateway's USD value per Star (F-104-f); ignored for any other provider. */
  staticRate: string;
  /** This gateway's own quick amounts, as `addPreset` keeps them; empty inherits the tenant's default. */
  depositPresets: string[];
  /** The callback address sent to the provider; empty = the tenant's panel domain (F-092-w). */
  callbackUrl: string;
  /** Tax on a top-up through this gateway, a percentage; empty inherits the tenant's default (ADR-0076). */
  taxRatePercent: string;
  /** A manual gateway's kind (F-803-g); fixed once it has a destination (`kind_in_use`). Empty on any other. */
  manualKind: string;
  /** The proof the payer must send, from the kind's fields — at least one (D-60 part 4). */
  requiredProof: string[];
  /** The payer's window in minutes, `WINDOW_MINUTES` bounds. */
  windowMinutes: string;
  /** The seller's usual time to confirm, whole minutes; empty = no figure shown to the payer (F-803-l). */
  confirmWithinMinutes: string;
}

/** More decimal places than the column that stores this field keeps. `places` is that column's. */
export type PrecisionError = { kind: "precision"; places: number };
export type FormError = "required" | "decimal" | "range" | "percent" | "merchantFormat" | "url" | "window" | "confirmWithin" | PrecisionError;
export type FormErrors = Partial<Record<keyof GatewayForm, FormError>>;

const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,8})?$/;
/** A rate's shape: `numeric(30, 18)` has 12 whole digits; its places are `PLACES`' to judge. */
const RATE = /^(0|[1-9]\d{0,11})(\.\d+)?$/;
/**
 * The scale of the column each decimal lands in (`billing.payment_gateway`,
 * and the identical columns on `tenant.tenant_gateway_config`).
 *
 * A `numeric` column does not refuse a place past its scale, it rounds it away:
 * a `feeCeiling` of `0.125` was once saved as `0.13` and the operator who typed
 * it was told nothing. The wire refuses the same values (`gateway-admin.schema.ts`);
 * this names the field the refusal belongs to before a request is made. Money
 * takes the columns' four places; the gateway currency's own are billing's to
 * refuse, naming the field (F-116-s).
 */
const PLACES: Partial<Record<keyof GatewayForm, number>> = {
  minAcceptAmount: MONEY_MAX_PLACES,
  maxAcceptAmount: MONEY_MAX_PLACES,
  feeFloor: MONEY_MAX_PLACES,
  feeCeiling: MONEY_MAX_PLACES,
  feeValue: 4,
  taxRatePercent: 4,
  // `numeric(30, 18)`: a currency change divides a rate (F-116-f), and the editor saves back what it read.
  staticRate: 18,
};

/** The places after the point in a value `DECIMAL` already accepted. */
const placesOf = (v: string): number => (v.split(".")[1] ?? "").length;

function tooFine(k: keyof GatewayForm, v: string): PrecisionError | undefined {
  const places = PLACES[k];
  return places !== undefined && placesOf(v) > places ? { kind: "precision", places } : undefined;
}
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
const NULLABLE = new Set<keyof GatewayForm>(["feeFloor", "feeCeiling", "minAcceptAmount", "maxAcceptAmount", "taxRatePercent"]);
/** Every field an edit may send, secrets and the block aside — they have rules of their own below. */
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
  "taxRatePercent",
] as const;

/** Only the platform owner links gateways, verifies them, or manages another tenant's (D-31). */
export const canManageLinks = (me: Me | null | undefined) => isPlatformTenant(me?.tenant.type);

/**
 * The actor the gateway form may build a body from, on this surface.
 *
 * On the ambient page it is whoever is signed in: the platform owner names a
 * tenant and blocks one there (`blockedReason`). On a reseller's screen the work
 * runs **as the reseller** (`billing/contract.gateways.md`, "A named
 * reseller's gateways"), so nothing a platform staff member holds may reach
 * the body — the route's schema is `.strict()` and would refuse a `tenantId`,
 * and `blockedReason` is `block_is_platform_owners` for everyone
 * here. One `null` in one place, rather than a rule repeated in the wizard and
 * the editor.
 */
export const surfaceActor = (me: Me | null, tenantId: string | null): Me | null => (tenantId === null ? me : null);

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
    blockedReason: "",
    merchantId: "",
    secretKey: "",
    webhookSecret: "",
    staticRate: "",
    depositPresets: [],
    callbackUrl: "",
    taxRatePercent: "",
    manualKind: "",
    requiredProof: [],
    windowMinutes: String(WINDOW_MINUTES.default),
    confirmWithinMinutes: "",
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
    blockedReason: g.blocked?.reason ?? "",
    merchantId: "",
    secretKey: "",
    webhookSecret: "",
    staticRate: g.staticRate ?? "",
    depositPresets: [...(g.depositPresets ?? [])],
    callbackUrl: g.callbackUrl ?? "",
    taxRatePercent: g.taxRatePercent ?? "",
    manualKind: g.manual?.kind ?? "",
    requiredProof: [...(g.manual?.requiredProof ?? [])],
    windowMinutes: String(g.manual?.windowMinutes ?? WINDOW_MINUTES.default),
    confirmWithinMinutes: g.manual?.confirmWithinMinutes == null ? "" : String(g.manual.confirmWithinMinutes),
  };
}

/**
 * A top-up tax rate as billing stores it (ADR-0076): a percentage, 0..100, at
 * most 4 places. Empty is allowed — a gateway's inherits the tenant's default,
 * the default's is no tax. The gateway form and the default-rate card judge
 * with this one function, so the two levels cannot disagree.
 */
export function taxRateError(raw: string): FormError | undefined {
  const v = raw.trim();
  if (v === "") return undefined;
  if (!DECIMAL.test(v)) return "decimal";
  const fine = tooFine("taxRatePercent", v);
  if (fine) return fine;
  // `DECIMAL` has no sign and at most 16 whole digits, so Number compares it exactly enough against 100.
  return Number(v) > 100 ? "percent" : undefined;
}

/** Each field that billing would refuse, named before a request is made. Billing still decides. */
export function validateForm(form: GatewayForm): FormErrors {
  const errors: FormErrors = {};
  for (const k of REQUIRED) if (form[k].trim() === "") errors[k] = "required";
  // An automatic fee is the provider's quote; the stored value is never read.
  if (form.feeCalculationMode === "manual" && form.feeValue.trim() === "") errors.feeValue = "required";
  for (const k of DECIMALS) {
    const v = form[k].trim();
    if (v === "" || errors[k]) continue;
    if (!DECIMAL.test(v)) errors[k] = "decimal";
    else {
      const fine = tooFine(k, v);
      if (fine) errors[k] = fine;
    }
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
    if (rate === "" || (RATE.test(rate) && Number(rate) <= 0)) errors.staticRate = "required";
    else if (!RATE.test(rate)) errors.staticRate = "decimal";
    else {
      const fine = tooFine("staticRate", rate);
      if (fine) errors.staticRate = fine;
    }
  }
  const tax = taxRateError(form.taxRatePercent);
  if (tax) errors.taxRatePercent = tax;
  if (isManualProvider(form.providerName)) Object.assign(errors, manualErrors(form));
  if (form.callbackUrl.trim() && !isWebAddress(form.callbackUrl.trim())) errors.callbackUrl = "url";
  return errors;
}

const WHOLE_MINUTES = /^\d{1,4}$/;

/** A manual gateway's own rules (F-803-c): a kind, at least one proof, a window billing accepts. */
function manualErrors(form: GatewayForm): FormErrors {
  const errors: FormErrors = {};
  if (!form.manualKind) errors.providerName = "required";
  if (form.requiredProof.length === 0) errors.requiredProof = "required";
  const minutes = form.windowMinutes.trim();
  if (!WHOLE_MINUTES.test(minutes) || Number(minutes) < WINDOW_MINUTES.min || Number(minutes) > WINDOW_MINUTES.max) errors.windowMinutes = "window";
  const within = form.confirmWithinMinutes.trim();
  if (within && (!WHOLE_MINUTES.test(within) || Number(within) < CONFIRM_WITHIN_MINUTES.min || Number(within) > CONFIRM_WITHIN_MINUTES.max)) {
    errors.confirmWithinMinutes = "confirmWithin";
  }
  return errors;
}

/** The usual confirmation time as billing takes it: whole minutes, or null for none. */
const confirmWithinOf = (form: GatewayForm): number | null => (form.confirmWithinMinutes.trim() ? Number(form.confirmWithinMinutes.trim()) : null);

/** The `manual` body a create sends whole: every manual gateway is confirmed by a person until F-803-f. */
function manualBody(form: GatewayForm): ManualSettingBody {
  return {
    kind: form.manualKind,
    confirmationMode: CONFIRMED_BY_PERSON,
    requiredProof: form.requiredProof,
    windowMinutes: Number(form.windowMinutes.trim()),
    confirmWithinMinutes: confirmWithinOf(form),
  };
}

/** What an edit changed of the setting; the kind and mode are not edited here. */
function manualPatch(before: GatewayForm, form: GatewayForm): ManualSettingBody {
  const patch: ManualSettingBody = {};
  const sameProof = form.requiredProof.length === before.requiredProof.length && form.requiredProof.every((id) => before.requiredProof.includes(id));
  if (!sameProof) patch.requiredProof = form.requiredProof;
  if (form.windowMinutes.trim() !== before.windowMinutes.trim()) patch.windowMinutes = Number(form.windowMinutes.trim());
  if (form.confirmWithinMinutes.trim() !== before.confirmWithinMinutes.trim()) patch.confirmWithinMinutes = confirmWithinOf(form);
  return patch;
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
  if (isPlatformTenant(me?.tenant?.type) && form.source === "tenant") {
    if (form.tenantId.trim()) body.tenantId = form.tenantId.trim();
  }
  // Billing requires a fee value; an automatic-fee gateway left it empty.
  if (body.feeValue === undefined || body.feeValue === "") body.feeValue = "0";
  if (form.depositPresets.length > 0) body.depositPresets = form.depositPresets;
  if (form.callbackUrl.trim()) body.callbackUrl = form.callbackUrl.trim();
  if (isManualProvider(form.providerName)) body.manual = manualBody(form);
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
  // F-104-ak: a reason blocks, an emptied box lifts the block.
  const reason = form.blockedReason.trim();
  if (isPlatformTenant(me?.tenant?.type) && original.source === "tenant" && reason !== before.blockedReason.trim()) {
    body.blockedReason = reason || null;
  }
  if (!samePresets(form.depositPresets, before.depositPresets)) body.depositPresets = form.depositPresets;
  if (form.callbackUrl.trim() !== before.callbackUrl.trim()) body.callbackUrl = form.callbackUrl.trim() || null;
  if (takesStaticRate(form.providerName)) {
    if (form.staticRate.trim() !== before.staticRate.trim()) body.staticRate = form.staticRate.trim();
    if (original.useLiveRate !== false) body.useLiveRate = false;
  }
  if (isManualProvider(original.providerName)) {
    const manual = manualPatch(before, form);
    if (Object.keys(manual).length > 0) body.manual = manual;
  }
  return { ...(body as UpdateGatewayBody), ...secrets(form) };
}

/** The fields a save would send, in the order it sends them — the edit screen's list of changes. */
export function changedFields(original: AdminGateway, form: GatewayForm, me: Me | null): (keyof GatewayForm)[] {
  const body = updateBody(original, form, me);
  // The `manual` body is named by the form fields it carries, so each is labelled and placed in its section.
  return Object.keys(body).flatMap((k) => (k === "manual" ? (Object.keys(body.manual ?? {}) as (keyof GatewayForm)[]) : [k as keyof GatewayForm]));
}
