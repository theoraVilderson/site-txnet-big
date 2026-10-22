"use client";

import { useLocale } from "@/context/LocaleContext";
import { OperatingCurrencyCard } from "../../../../_components/OperatingCurrencyCard";
import { TenantTimeZoneCard } from "../../../../_components/TenantTimeZoneCard";
import { PageHeader } from "../../../../_components/kit/PageHeader";
import { ResellerLimitsCard } from "../../_components/ResellerLimitsCard";
import { SupportAccessCard } from "../../_components/SupportAccessCard";
import { DataExportCard } from "../../_components/DataExportCard";
import { OverageCapCard, PackageChangeCard, ProductQuotasCard } from "../../_components/QuotaCards";
import { ONBOARDING_KEYS as K } from "../../../_lib/onboarding";
import { SelfMoveSettings } from "../../../../_components/SelfMoveSettings";
import { useUserMessage } from "../../users/[userId]/_components/useUserMessage";

/**
 * A reseller's settings (UX-2-b): the cards the workspace's home once
 * stacked under its steps, now the page of the menu's settings section. By
 * the reseller the path names, never the session's tenant (ADR-0064); each
 * card reads, admits and refuses on its own (invariant 21).
 */
export function ResellerSettingsView({ id }: { id: string }) {
  const { t } = useLocale();
  const message = useUserMessage();
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
        {/* F-410-f: its users moving their own config; a product's override is on the product's sheet. */}
        <SelfMoveSettings tenantId={id} productId={null} errorMessage={message} />
        {/* F-117-f: the platform's access to this reseller's people; nothing to platform staff. */}
        <SupportAccessCard tenantId={id} />
        {/* F-212-c: the reseller takes all its data, in any status (catalog §14.8). */}
        <DataExportCard tenantId={id} />
      </div>
    </div>
  );
}
