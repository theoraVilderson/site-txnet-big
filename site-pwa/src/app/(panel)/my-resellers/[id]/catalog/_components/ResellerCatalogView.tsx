"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocale } from "@/context/LocaleContext";
import { authApi } from "@/lib/auth-api";
import { catalogAdminApi } from "@/lib/catalog-api";
import { myResellerCatalogPath, myResellerCatalogTranslationsPath } from "@/lib/routes";
import { CatalogSurfaceProvider, type CatalogSurface } from "../../../../catalog/_lib/surface";
import { RESELLER_CATALOG_KEYS as K, catalogRefusalKey } from "../../../_lib/catalog";
import { useWorkspaceSelf } from "../../../_lib/workspace";

/**
 * A reseller's catalog, as one surface the catalog components read from
 * context (F-066-w8, `panel-web/contract.resellers.md` "Its catalog"). The
 * screen itself — the list or the review — is the ambient page's own
 * component, handed this surface.
 *
 * Why not the ambient `/catalog`: the owner of a reseller signs in to the
 * platform owner's tenant (ADR-0059), so that page would price the
 * **platform's** products and answer 200 doing it.
 *
 * No permission is judged here. Billing admits the reseller's owner, a staff
 * seat of it holding `catalog.manage`, or platform support (invariant 21), and
 * a refusal is shown as its own sentence.
 *
 * `embedded`: the setup wizard's pricing step (UX-2-d) — the same screen
 * without its page frame; `onChanged` tells it the catalog changed.
 */
export function ResellerCatalogView({
  id,
  children,
  embedded = false,
  onChanged,
}: {
  id: string;
  children: ReactNode;
  embedded?: boolean;
  onChanged?: () => void;
}) {
  const { t } = useLocale();
  const [slug, setSlug] = useState<string | null>(null);
  const self = useWorkspaceSelf(id);

  // The name for the title, when the visitor owns it; staff see the plain title.
  useEffect(() => {
    let alive = true;
    authApi
      .ownedResellers()
      .then((r) => alive && setSlug(r.resellers.find((x) => x.id === id)?.slug ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);

  const surface = useMemo<CatalogSurface>(
    () => ({
      tenantId: id,
      api: catalogAdminApi(id),
      catalogHref: myResellerCatalogPath(id, self),
      translationsHref: myResellerCatalogTranslationsPath(id, self),
      refusalKey: catalogRefusalKey,
      // A reseller's product is sold to the reseller's groups, read by the path (F-102-g-d).
      // Inside the setup wizard (UX-2-d) the step names whose it is.
      embedded,
      onChanged,
      chrome: embedded ? null : (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-bold text-text-secondary">{slug ? t("common", K.title, { slug }) : t("common", K.titlePlain)}</p>
        </div>
      ),
    }),
    // `t` is stable for a language; the chrome is rebuilt when the name arrives.
    [id, slug, self, t, embedded, onChanged],
  );

  return <CatalogSurfaceProvider value={surface}>{children}</CatalogSurfaceProvider>;
}
