import { ApiError } from "@/lib/api-error";
import type { ShopOffer } from "@/lib/billing-api";

/**
 * The shop's rules that are not layout (F-111-e, F-114-d, `panel-web/contract.shop.md`).
 */

/** Billing's refusal of a wallet payment it cannot cover (`billing/contract.purchase.md`). */
export const INSUFFICIENT_BALANCE = "insufficient_balance";

/**
 * What a refused pay says is missing, or `null`. Billing's own figure, rounded
 * **up** to the cent (F-111-c) — never recomputed here from a balance, which
 * would put the rounding rule in two places.
 */
export function shortfallOf(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.reason !== INSUFFICIENT_BALANCE) return null;
  const missing = e.facts.missing;
  return typeof missing === "string" && /^\d+(\.\d+)?$/.test(missing) ? missing : null;
}

/** A non-negative decimal string as an integer at `scale` places — exact, never a float (C-02). */
function scaled(value: string, scale: number): bigint {
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole + frac.padEnd(scale, "0").slice(0, scale));
}

/**
 * The top-up to pre-fill: `missing`, raised to the gateway's minimum. Below it
 * the gateway refuses the top-up, and a larger one credits whole, so it still
 * covers (`billing/contract.purchase.md` "The shortfall").
 */
export function prefillAmount(missing: string, minAmount: string | null): string {
  if (!minAmount || !/^\d+(\.\d+)?$/.test(minAmount)) return missing;
  const scale = Math.max(missing.split(".")[1]?.length ?? 0, minAmount.split(".")[1]?.length ?? 0);
  return scaled(minAmount, scale) > scaled(missing, scale) ? minAmount : missing;
}

export interface OfferGroup {
  productId: string;
  productNameKey: string;
  descriptionKey: string | null;
  /** The product's live categories, as billing answered them. */
  categoryKeys: string[];
  variants: ShopOffer[];
}

/** Variants under their product, both in the order billing answered (by SKU). */
export function groupOffers(offers: readonly ShopOffer[]): OfferGroup[] {
  const groups = new Map<string, OfferGroup>();
  for (const offer of offers) {
    const group = groups.get(offer.productId) ?? {
      productId: offer.productId,
      productNameKey: offer.productNameKey,
      descriptionKey: offer.descriptionKey,
      categoryKeys: offer.categories.map((c) => c.key),
      variants: [],
    };
    group.variants.push(offer);
    groups.set(offer.productId, group);
  }
  return [...groups.values()];
}

/** The tabs over the cards: every category any offer is filed in, once, in the order first met (F-114-d). */
export function categoriesOf(offers: readonly ShopOffer[]): Array<{ key: string; nameKey: string }> {
  const seen = new Map<string, { key: string; nameKey: string }>();
  for (const offer of offers) for (const c of offer.categories) if (!seen.has(c.key)) seen.set(c.key, c);
  return [...seen.values()];
}

/** A variant's limit for one metric, as the catalog wrote it (`{metric: {limit}}`), or `null` when it sets none. */
export function quotaLimit(quotas: unknown, metric: "traffic_bytes" | "concurrent_devices"): number | null {
  if (!quotas || typeof quotas !== "object") return null;
  const entry = (quotas as Record<string, unknown>)[metric];
  if (!entry || typeof entry !== "object") return null;
  const limit = (entry as { limit?: unknown }).limit;
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : null;
}

/** Whether the variant carries a name of its own, rather than its product's — then the chip says it (F-114-d). */
export const hasOwnName = (offer: ShopOffer) => offer.nameKey !== offer.productNameKey;

/** The shop's hand-off to the top-up page (`panelDepositForInvoicePath`). */
export interface ForInvoice {
  invoiceId: string;
  /** Billing's shortfall, at most two places — what a deposit amount takes. */
  missing: string;
}

/** The hand-off read off the top-up page's query, or `null` when it is not a well-formed one. */
export function forInvoiceOf(invoiceId: string | null, missing: string | null): ForInvoice | null {
  if (!invoiceId || !/^[0-9a-f-]{36}$/i.test(invoiceId)) return null;
  if (!missing || !/^\d{1,12}(\.\d{1,2})?$/.test(missing)) return null;
  return { invoiceId, missing };
}

/**
 * The invoice a top-up was started for, kept for the one tab across the trip to
 * the bank: the gateway returns to `/payment/success`, which has no other way
 * to know where the user was going. Session storage, not local: a second tab
 * is a second trip. Only an id — never a code, never a figure.
 */
const RETURN_KEY = "txnet.shop.returnInvoice";

export function rememberReturnInvoice(invoiceId: string): void {
  try {
    sessionStorage.setItem(RETURN_KEY, invoiceId);
  } catch {
    // No storage (a private window, a blocked origin): the top-up page's own link still goes back.
  }
}

export function returnInvoice(): string | null {
  try {
    return sessionStorage.getItem(RETURN_KEY);
  } catch {
    return null;
  }
}

export function forgetReturnInvoice(): void {
  try {
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // Nothing was kept.
  }
}
