import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { FormErrors, GatewayForm } from "./gateway-form";

const G = FrontendI18nKeys.common.gateways;
const F = G.form;

/**
 * The edit screen's sections (F-102-d): which fields each one holds, so the
 * section list can mark one that has a change or an error, and a refused save
 * can scroll to the first section that needs attention. Rules stay in
 * `gateway-form.ts`.
 */

export type EditorSectionId = "general" | "amounts" | "fee" | "connection";

export const EDITOR_SECTIONS: readonly { id: EditorSectionId; fields: readonly (keyof GatewayForm)[] }[] = [
  { id: "general", fields: ["displayName", "providerName", "gatewayCategory", "isActive", "blockedReason"] },
  { id: "amounts", fields: ["minAcceptAmount", "maxAcceptAmount", "depositPresets"] },
  { id: "fee", fields: ["feeCalculationMode", "feeType", "feeValue", "feeFloor", "feeCeiling", "taxRatePercent"] },
  // A manual gateway's proof and window sit where a provider's keys do (F-803-g).
  { id: "connection", fields: ["merchantId", "secretKey", "webhookSecret", "staticRate", "callbackUrl", "requiredProof", "windowMinutes", "confirmWithinMinutes"] },
];

export function sectionOf(field: keyof GatewayForm): EditorSectionId | null {
  return EDITOR_SECTIONS.find((s) => s.fields.includes(field))?.id ?? null;
}

export function firstInvalidSection(errors: FormErrors): EditorSectionId | null {
  return EDITOR_SECTIONS.find((s) => s.fields.some((f) => errors[f]))?.id ?? null;
}

/** What the list of changes calls each field — the same labels the form shows. */
export const FIELD_LABELS: Partial<Record<keyof GatewayForm, string>> = {
  displayName: F.displayName,
  providerName: F.provider,
  gatewayCategory: F.category,
  isActive: F.isActive,
  blockedReason: F.blockedReason,
  minAcceptAmount: F.minAmount,
  maxAcceptAmount: F.maxAmount,
  depositPresets: G.presets.title,
  feeCalculationMode: F.feeMode,
  feeType: F.feeType,
  feeValue: F.feeValue,
  feeFloor: F.feeFloor,
  feeCeiling: F.feeCeiling,
  taxRatePercent: G.tax.label,
  merchantId: G.merchantId,
  secretKey: G.secretKey,
  webhookSecret: G.fields.webhookSecret,
  staticRate: G.fields.starRate,
  callbackUrl: G.callback.label,
  requiredProof: G.manual.requiredProof,
  windowMinutes: G.manual.windowMinutes,
  confirmWithinMinutes: G.manual.confirmWithinMinutes,
};
