"use client";

import { useLocale } from "@/context/LocaleContext";
import { OperatingCurrencyCard } from "../../../../_components/OperatingCurrencyCard";
import { TenantTimeZoneCard } from "../../../../_components/TenantTimeZoneCard";
import { PageHeader } from "../../../../_components/kit/PageHeader";
import { ResellerLimitsCard } from "../../_components/ResellerLimitsCard";
import { SupportAccessCard } from "../../_components/SupportAccessCard";
import { OverageCapCard, PackageChangeCard, ProductQuotasCard } from "../../_components/QuotaCards";
import { ONBOARDING_KEYS as K } from "../../../_lib/onboarding";

/**
 * A reseller's settings (UX-2-b): the cards the workspace's home once
 * stacked under its steps, now the page of the menu's settings section. By
 * the reseller the path names, never the session's tenant (ADR-0064); each
 * card reads, admits and refuses on its own (invariant 21).
 */
export function ResellerSettingsView({ id }: { id: string }) {
  const { t } = useLocale();
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <PageHeader title={t("common", K.settingsPage.title)} subtitle={t("common", K.settingsPage.subtitle)} />
      <div className="space-y-3">
        {/* F-116-h. */}
        <OperatingCurrencyCard tenantId={id} scope="reseller" />
        {/* TZ-1-e: the reseller's own clock. */}
        <TenantTimeZoneCard tenantId={id} scope="reseller" />
        <ResellerLimitsCard tenantId={id} />
        <ProductQuotasCard tenantId={id} />
        <OverageCapCard tenantId={id} />
        <PackageChangeCard tenantId={id} />
        {/* F-117-f: the platform's access to this reseller's people; nothing to platform staff. */}
        <SupportAccessCard tenantId={id} />
      </div>
    </div>
  );
}
