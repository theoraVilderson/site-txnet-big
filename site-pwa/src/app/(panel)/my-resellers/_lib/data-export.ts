import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { DataExportStatus } from "@/lib/tenant-data-export-api";
import type { Tone } from "../../_components/kit";

/** The «export my data» strings (C-06). */
export const DATA_EXPORT_KEYS = FrontendI18nKeys.common.dataExport;
const K = DATA_EXPORT_KEYS;

/** Every refusal the three routes give (tenant `contract.data-export.md`), each with its own sentence. */
export type DataExportRefusal = keyof typeof K.refusals;

/** The refusal's sentence key, or `null` for one this card has no sentence for — the generic answer then. */
export function dataExportRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in K.refusals ? K.refusals[reason as DataExportRefusal] : null;
}

/**
 * How long until the service's 24 h clock (rule 2) lets the next export be
 * asked for, or `null` when it already does. The card re-reads once at that
 * instant, so a page left open over the day offers it again without a poll
 * and without judging the clock itself.
 */
export function msUntilNext(nextAllowedAt: string | null, now: number): number | null {
  if (nextAllowedAt === null) return null;
  return Math.max(0, Date.parse(nextAllowedAt) - now);
}

/** The pill per status; gold is never on a control, and only `ready` is a success. */
export const STATUS_TONE: Record<DataExportStatus, Tone> = {
  queued: "info",
  building: "info",
  ready: "success",
  expired: "neutral",
  failed: "error",
};
