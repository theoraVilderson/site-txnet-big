"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { AiOffers } from "./AiOffers";
import { AiSettingsPanel } from "./AiSettingsPanel";
import { AtRiskList } from "./AtRiskList";
import { K } from "./ai-ui";
import { MarginsList } from "./MarginsList";
import { PlanLayoutView } from "./PlanLayoutView";
import { ResellersAtRisk } from "./ResellersAtRisk";
import { UsageForecastView } from "./UsageForecastView";
import { UpliftReportView } from "./UpliftReportView";
import { PageHeader, Tabs } from "../../_components/kit";
import { isPlatformTenant } from "@/lib/tenant-type";

const TABS = ["settings", "offers", "atRisk", "margins", "layout", "usage", "report", "resellers"] as const;
type Tab = (typeof TABS)[number];

/**
 * The tenant's AI page (F-038-j2, ADR-0109 points 7, 13; ADR-0110) over ai's
 * `/api/ai/admin/*` (F-038-j1). Six tabs, each reading only when opened:
 * settings, the discount offers the engine may give, the customers at risk
 * with the engine's reasons, each plan's margin with the losing ones flagged
 * (F-1528), the plan layout its users' use suggests (F-1527), and the uplift
 * report against the holdout, and the usage forecast with the billing wallet's
 * run-out (F-1525-b). The platform owner has one more: its resellers
 * by quota run-out and churn risk (F-038-o3) — hidden from anyone else, whom
 * ai would refuse.
 *
 * Nothing here decides scope: ai answers the gate's tenant, and no call names one.
 */
export function AiView() {
  const { t } = useLocale();
  const { me } = usePanelSession();
  const [tab, setTab] = useState<Tab>("settings");
  const tabs = TABS.filter((id) => id !== "resellers" || isPlatformTenant(me?.tenant?.type));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        icon={Sparkles}
        title={t("common", K.title)}
        subtitle={t("common", K.subtitle)}
      />

      <Tabs<Tab>
        ariaLabel={t("common", K.title)}
        variant="pills"
        value={tab}
        onChange={setTab}
        tabs={tabs.map((id) => ({ value: id, label: t("common", K.tabs[id]) }))}
      />

      {tab === "settings" ? <AiSettingsPanel /> : tab === "offers" ? <AiOffers /> : tab === "atRisk" ? <AtRiskList /> : tab === "margins" ? <MarginsList /> : tab === "layout" ? <PlanLayoutView /> : tab === "usage" ? <UsageForecastView /> : tab === "resellers" ? <ResellersAtRisk /> : <UpliftReportView />}
    </div>
  );
}
