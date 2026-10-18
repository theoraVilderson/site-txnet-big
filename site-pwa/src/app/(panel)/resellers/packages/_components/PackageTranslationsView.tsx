"use client";

import { useLocale } from "@/context/LocaleContext";
import { packageTranslationsApi } from "@/lib/tenant-api";
import { PANEL_RESELLER_PACKAGES } from "@/lib/routes";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { TranslationsView } from "../../../catalog/_components/TranslationsView";
import type { TranslationReview } from "../../../catalog/_lib/surface";
import { Alert } from "../../_components/resellers-ui";
import { PACKAGE_KEYS as K } from "../../_lib/packages";
import { RESELLER_KEYS, canAdministerResellers } from "../../_lib/resellers";

/** tenant-service's drafts of package names and descriptions, on the catalog's own review view (ADR-0154 (6)). */
const PACKAGE_REVIEW: TranslationReview = {
  api: packageTranslationsApi,
  backHref: PANEL_RESELLER_PACKAGES,
  text: K.translations,
};

/**
 * `/resellers/packages/translations` (PK-1-h): the packages' machine drafts
 * reviewed and published before a buyer reads them. Who may is
 * tenant-service's to decide, as on the list; the check spares a reseller who
 * typed the path (contract.reseller-packages.md rule 1).
 */
export function PackageTranslationsView() {
  const { t } = useLocale();
  const { me, isLoading } = usePanelSession();
  if (isLoading) return null;
  if (!canAdministerResellers(me)) {
    return (
      <div className="mx-auto w-full max-w-7xl p-4 md:p-8">
        <Alert>{t("common", RESELLER_KEYS.refusals.not_platform_owner)}</Alert>
      </div>
    );
  }
  return <TranslationsView review={PACKAGE_REVIEW} />;
}
