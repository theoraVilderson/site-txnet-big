import type { OverageBody, PackageProductBody, ProductQuota, QuotaOverageMode } from "@/lib/tenant-api";
import { RESELLER_KEYS } from "./resellers";

/** The limits page's strings (C-06). */
export const LIMIT_KEYS = RESELLER_KEYS.limits;

/** shared-core's `RESELLER_LIMITS`, in its order — one list for the panel, in `lib/reseller-limits.ts`. */
export { RESELLER_LIMIT_KEYS } from "@/lib/reseller-limits";

/**
 * A limit typed in a box: a whole number, or `null` when "no limit" is ticked;
 * `undefined` for anything else (the save stays off). `max` is the key's own
 * bound, billing's — the box only helps.
 */
export function limitValueOf(typed: string, noLimit: boolean, max: number): number | null | undefined {
  if (noLimit) return null;
  const v = typed.trim();
  if (!/^\d{1,7}$/.test(v)) return undefined;
  const n = Number(v);
  return n <= max ? n : undefined;
}

/** A product quota window's highest number (tenant's `PUT …/products/:productId`). */
export const PRODUCT_WINDOW_MAX = 10_000_000;

/**
 * A unit price typed: positive, at most two places, as the `/overage` routes
 * take it (a string, C-02). `undefined` for anything else — never 0, which is
 * not a price but "free", and the service refuses it.
 */
export function unitPriceOf(typed: string): string | undefined {
  const v = typed.trim();
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(v)) return undefined;
  return /[1-9]/.test(v) ? v : undefined;
}

/** `stop`, or `overage` with a valid price; `undefined` keeps save off. */
export function overageBodyOf(mode: QuotaOverageMode, typedPrice: string): OverageBody | undefined {
  if (mode === "stop") return { mode };
  const unitPrice = unitPriceOf(typedPrice);
  return unitPrice === undefined ? undefined : { mode, unitPrice };
}

export type ProductQuotaForm = { day: string; week: string; month: string; mode: QuotaOverageMode; price: string };

/**
 * A package's terms for one product as the form holds them (F-019-v6): each
 * window a whole number or blank — blank is **no bound** there, never 0, which
 * includes nothing. The whole terms go every time; `undefined` keeps save off.
 */
export function productQuotaBodyOf(form: ProductQuotaForm): PackageProductBody | undefined {
  const body: PackageProductBody = {};
  for (const w of ["day", "week", "month"] as const) {
    const v = form[w].trim();
    if (v === "") continue;
    if (!/^\d{1,8}$/.test(v) || Number(v) > PRODUCT_WINDOW_MAX) return undefined;
    body[w] = Number(v);
  }
  const overage = overageBodyOf(form.mode, form.price);
  if (overage === undefined) return undefined;
  if (overage.mode === "overage") body.overage = overage;
  return body;
}

/** The form a listed product opens with: its terms as read; a product not listed opens empty, `stop`. */
export function productQuotaFormOf(quota: ProductQuota | null): ProductQuotaForm {
  const n = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
  return { day: n(quota?.day), week: n(quota?.week), month: n(quota?.month), mode: quota?.overage.mode ?? "stop", price: quota?.overage.unitPrice ?? "" };
}
