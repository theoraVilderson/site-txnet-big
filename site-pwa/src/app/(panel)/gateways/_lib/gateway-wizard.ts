import { validateForm, type FormErrors, type GatewayForm } from "./gateway-form";
import type { Provider } from "./provider-fields";

/**
 * The add-gateway wizard (F-102-e): the same {@link GatewayForm} the edit modal
 * uses, walked one concern at a time. Nothing here validates or serialises on
 * its own — `validateForm`, `createBody` stay the only rules.
 */

export type WizardStepId = "provider" | "details" | "fee" | "secrets" | "review";

export const WIZARD_STEPS: readonly { id: WizardStepId; fields: readonly (keyof GatewayForm)[] }[] = [
  { id: "provider", fields: ["source", "tenantId", "providerName"] },
  { id: "details", fields: ["displayName", "gatewayCategory", "minAcceptAmount", "maxAcceptAmount", "isActive"] },
  { id: "fee", fields: ["feeCalculationMode", "feeType", "feeValue", "feeFloor", "feeCeiling"] },
  { id: "secrets", fields: ["merchantId", "secretKey", "webhookSecret", "staticRate", "callbackUrl", "verificationStatus"] },
  { id: "review", fields: [] },
];

export type { Provider } from "./provider-fields";

/** What a provider implies: the category billing files it under, and a name to start from. */
export const PROVIDER_DEFAULTS: Record<Provider, { category: string; name: string }> = {
  zarinpal: { category: "domestic_rial", name: "Zarinpal" },
  idpay: { category: "domestic_rial", name: "IDPay" },
  nowpayments: { category: "crypto", name: "NOWPayments" },
  stripe: { category: "international_card", name: "Stripe" },
  oxapay: { category: "crypto", name: "OxaPay" },
  airwallex: { category: "international_card", name: "Airwallex" },
  telegram_stars: { category: "in_chat", name: "Telegram Stars" },
  bale: { category: "in_chat", name: "Bale" },
};

const SUGGESTED_NAMES = new Set(Object.values(PROVIDER_DEFAULTS).map((d) => d.name));

/** Pick a provider. A display name the operator typed is kept; one the wizard suggested follows the provider. */
export function applyProvider(form: GatewayForm, provider: Provider): GatewayForm {
  const d = PROVIDER_DEFAULTS[provider];
  const name = form.displayName.trim();
  return {
    ...form,
    providerName: provider,
    gatewayCategory: d.category,
    displayName: name === "" || SUGGESTED_NAMES.has(name) ? d.name : form.displayName,
  };
}

export function stepErrors(form: GatewayForm, step: WizardStepId): FormErrors {
  const all = validateForm(form);
  const fields = WIZARD_STEPS.find((s) => s.id === step)?.fields ?? [];
  const out: FormErrors = {};
  for (const k of fields) if (all[k]) out[k] = all[k];
  return out;
}

export function firstInvalidStep(form: GatewayForm): WizardStepId | null {
  for (const s of WIZARD_STEPS) if (Object.keys(stepErrors(form, s.id)).length > 0) return s.id;
  return null;
}

// Exact decimals over BigInt, scaled to 8 places — billing's own precision (C-02).
const SCALE = 8;
const ONE = BigInt(10) ** BigInt(SCALE);
const HUNDRED = BigInt(100);
const CENT = ONE / HUNDRED;
const DECIMAL = /^(\d{1,16})(?:\.(\d{1,8}))?$/;

function toScaled(v: string): bigint | null {
  const m = DECIMAL.exec(v.trim());
  if (!m) return null;
  return BigInt(m[1]) * ONE + BigInt((m[2] ?? "").padEnd(SCALE, "0"));
}

function fromScaled(n: bigint): string {
  const whole = n / ONE;
  const frac = (n % ONE).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** To the cent, **up** — `gateway-pricing.ts`'s `centsUp`. Never negative here. */
function centsUp(n: bigint): bigint {
  return ((n + CENT - BigInt(1)) / CENT) * CENT;
}

/**
 * The fee billing would charge on `amount` (`gateway-pricing.ts`): fixed, or a
 * percentage, rounded up to the cent, then clamped to floor and ceiling — that
 * order is `feeOf`'s, so a 12.3% fee on 1 previews the 0.13 the payer is
 * charged and not 0.123. `null` when it cannot be known here — an automatic fee
 * is quoted by the provider at payment time.
 */
export function feePreview(form: GatewayForm, amount: string): string | null {
  if (form.feeCalculationMode !== "manual") return null;
  const value = toScaled(form.feeValue);
  const basis = toScaled(amount);
  if (value === null || basis === null) return null;
  let fee = centsUp(form.feeType === "fixed" ? value : (basis * value) / (HUNDRED * ONE));
  const floor = form.feeFloor.trim() ? toScaled(form.feeFloor) : null;
  const ceiling = form.feeCeiling.trim() ? toScaled(form.feeCeiling) : null;
  if (floor !== null && fee < floor) fee = floor;
  if (ceiling !== null && fee > ceiling) fee = ceiling;
  return fromScaled(fee);
}
