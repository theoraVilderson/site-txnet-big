"use client";

import { useLocale } from "@/context/LocaleContext";
import type { CatalogProduct } from "@/lib/catalog-api";
import { AudienceSection } from "../../_components/AudienceSection";
import { CATALOG_KEYS } from "../_lib/catalog-form";
import { useCatalogSurface } from "../_lib/surface";
import { useMessage } from "./catalog-ui";

const A = CATALOG_KEYS.audience;

/**
 * Whether this screen sets the product's audience (PT-1-b): it is the
 * surface's own tenant's. The platform owner's `/catalog` lists every tenant's
 * products, but its groups are the platform's — a reseller's product is given
 * its audience from that reseller's workspace, with that reseller's groups.
 */
export const ownsAudience = (product: Pick<CatalogProduct, "tenantId">, surfaceTenantId: string | null, myTenantId: string | null): boolean =>
  product.tenantId === (surfaceTenantId ?? myTenantId);

/**
 * Who may buy this product (PT-1-b, ADR-0142 (4)) — the shop, a direct link and
 * an issue by hand all ask it; a service already sold stays. The shared audience
 * section (GR-1-x), saved on the product's own route.
 */
export function ProductAudienceSection({ product, onSaved }: { product: CatalogProduct; onSaved: () => Promise<void> }) {
  const { t } = useLocale();
  const message = useMessage();
  const surface = useCatalogSurface();
  return (
    <AudienceSection
      tenantId={surface.tenantId}
      saved={product.userGroupIds ?? []}
      save={async (ids) => (await surface.api.setAudience(product.id, ids)).userGroupIds}
      onSaved={() => void onSaved()}
      errorMessage={message}
      text={{ title: t("common", A.title), subtitle: t("common", A.subtitle), save: t("common", A.save), saved: t("common", A.saved) }}
    />
  );
}
