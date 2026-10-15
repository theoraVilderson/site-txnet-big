"use client";

import { ShieldCheck } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { billingApi } from "@/lib/billing-api";
import { PANEL_MANUAL_PAYMENTS } from "@/lib/routes";
import { useOpenPaymentsLive } from "../../../payments/manual/_hooks/useOpenPayments";
import { EmptyState } from "../../kit";
import { FooterLink } from "../parts";
import { useWidgetSource } from "../useWidgetSource";
import { WidgetBody } from "../WidgetFrame";

const D = FrontendI18nKeys.common.dashboard;

/** Manual payments (UX-1-r, D5): how many wait for a person — the open list's first page, as the menu badge counts. */
export default function ManualPaymentsWidget() {
  const { t } = useLocale();
  const source = useWidgetSource("manual-payments", async () => (await billingApi.manualPayments()).length);
  useOpenPaymentsLive(source.retry);
  return (
    <WidgetBody
      source={source}
      isEmpty={(n) => n === 0}
      empty={<EmptyState icon={ShieldCheck} title={t("common", D.manualPayments.none)} className="py-4" />}
    >
      {(n) => (
        <div className="flex h-full flex-col">
          <p className="text-2xl font-black tabular-nums text-text-primary">{t("common", D.manualPayments.waiting, { count: n })}</p>
          <FooterLink href={PANEL_MANUAL_PAYMENTS}>{t("common", D.manualPayments.open)}</FooterLink>
        </div>
      )}
    </WidgetBody>
  );
}
