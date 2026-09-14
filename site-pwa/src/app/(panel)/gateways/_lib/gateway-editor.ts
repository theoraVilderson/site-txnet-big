import type { FormErrors, GatewayForm } from "./gateway-form";

/**
 * The edit screen's sections (F-102-d): which fields each one holds, so the
 * section list can mark one that has a change or an error, and a refused save
 * can scroll to the first section that needs attention. Rules stay in
 * `gateway-form.ts`.
 */

export type EditorSectionId = "general" | "amounts" | "fee" | "connection";

export const EDITOR_SECTIONS: readonly { id: EditorSectionId; fields: readonly (keyof GatewayForm)[] }[] = [
  { id: "general", fields: ["displayName", "providerName", "gatewayCategory", "isActive", "verificationStatus"] },
  { id: "amounts", fields: ["minAcceptAmount", "maxAcceptAmount", "depositPresets"] },
  { id: "fee", fields: ["feeCalculationMode", "feeType", "feeValue", "feeFloor", "feeCeiling"] },
  { id: "connection", fields: ["merchantId", "secretKey", "callbackUrl"] },
];

export function sectionOf(field: keyof GatewayForm): EditorSectionId | null {
  return EDITOR_SECTIONS.find((s) => s.fields.includes(field))?.id ?? null;
}

export function firstInvalidSection(errors: FormErrors): EditorSectionId | null {
  return EDITOR_SECTIONS.find((s) => s.fields.some((f) => errors[f]))?.id ?? null;
}
