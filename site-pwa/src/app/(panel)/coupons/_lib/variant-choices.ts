import type { Me } from "@/lib/auth-api";
import type { CatalogProductDetail } from "@/lib/catalog-api";
import { isPlatformOwner, type CouponOwnerChoice } from "./coupon-form";

/** One line of the free-service variant picker. */
export interface VariantChoice {
  value: string;
  product: string;
  sku: string;
  /** `null` = permanent. */
  durationDays: number | null;
}

/**
 * The tenant a new coupon or gift batch will belong to — `null` = the
 * platform's. Only the platform owner chooses; anyone else's is its own, as
 * billing's `ownerOfNew` decides.
 */
export function variantOwnerTenant(owner: CouponOwnerChoice, tenantId: string, me: Me | null): string | null {
  if (!isPlatformOwner(me)) return me?.tenant?.id ?? null;
  if (owner === "platform") return null;
  if (owner === "tenant") return tenantId.trim();
  return me?.tenant?.id ?? null;
}

/**
 * What a `free_grant` coupon may give (F-502-l-a): a live variant of a live
 * product that is the platform's or the coupon owner's, whatever its
 * visibility. Billing checks the same again on save; this only keeps the
 * picker from offering a sure refusal.
 */
export function variantChoices(catalog: readonly CatalogProductDetail[], ownerTenant: string | null): VariantChoice[] {
  const mine = (tenantId: string | null) => tenantId === null || tenantId === ownerTenant;
  return catalog
    .filter((p) => p.isActive && mine(p.tenantId))
    .flatMap((p) =>
      p.variants
        .filter((v) => v.isActive && mine(v.tenantId))
        .map((v) => ({ value: v.id, product: p.key, sku: v.sku, durationDays: v.durationDays })),
    );
}
