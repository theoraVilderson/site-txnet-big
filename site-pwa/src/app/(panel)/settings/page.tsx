"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ManualRateCard } from "../_components/ManualRateCard";
import { OperatingCurrencyCard } from "../_components/OperatingCurrencyCard";
import { TenantTimeZoneCard } from "../_components/TenantTimeZoneCard";
import { usePanelSession } from "../_context/PanelSessionContext";
import { EmailSection } from "./_components/EmailSection";
import { canPinRates, canSetPlatformCurrency } from "./_lib/settings";
import { MessengerSection } from "./_components/MessengerSection";
import { NotificationsSection } from "./_components/NotificationsSection";
import { TimeZoneSection } from "./_components/TimeZoneSection";

/**
 * The user's own account settings: the email address (F-035-j), then which
 * service notices they are told and their quiet hours (F-601-m), and which
 * messenger tells them (F-601-u), and their time zone (TZ-1-e). The
 * sidebar's `settings` entry points here.
 *
 * The platform's own operating currency (F-116-h) is here too, for its staff
 * with `tenant.manage` (or `*`) only: a reseller can grant itself that key, so the
 * tenant type gates it as well. A reseller's currency is in its workspace,
 * because its owner's session carries the platform tenant (invariant 21).
 * The platform's time zone (TZ-1-e) sits beside it under the same rule
 * (`tenant/contract.time-zone.md` rule 4).
 *
 * The manual-rate card (F-116-l) is here for anyone holding `currency.pin`,
 * on either kind of tenant: the pin routes scope to the session's own books,
 * so on a reseller's domain its staff pin for that reseller only. For the
 * same invariant-21 reason it is not in a reseller's workspace.
 */
export default function SettingsPage() {
  const { t } = useLocale();
  const { me } = usePanelSession();
  return (
    <div className="mx-auto w-full max-w-[560px] px-6 py-10">
      <h1 className="mb-6 text-xl font-bold text-text-primary">
        {t("common", FrontendI18nKeys.common.settings.title)}
      </h1>
      <EmailSection />
      <TimeZoneSection />
      <NotificationsSection />
      <MessengerSection />
      {me && canSetPlatformCurrency(me) && <OperatingCurrencyCard tenantId={me.tenant.id} scope="platform" />}
      {me && canSetPlatformCurrency(me) && <TenantTimeZoneCard tenantId={me.tenant.id} scope="platform" />}
      {me && canPinRates(me) && (
        <ManualRateCard scope={me.tenant.type === "platform_owner" ? "platform" : "reseller"} />
      )}
    </div>
  );
}
