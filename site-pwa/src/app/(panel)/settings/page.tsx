"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { OperatingCurrencyCard } from "../_components/OperatingCurrencyCard";
import { usePanelSession } from "../_context/PanelSessionContext";
import { EmailSection } from "./_components/EmailSection";
import { MessengerSection } from "./_components/MessengerSection";
import { NotificationsSection } from "./_components/NotificationsSection";

/**
 * The user's own account settings: the email address (F-035-j), then which
 * service notices they are told and their quiet hours (F-601-m), and which
 * messenger tells them (F-601-u). The
 * sidebar's `settings` entry points here.
 *
 * The platform's own operating currency (F-116-h) is here too, for its staff
 * with `tenant.manage` only: a reseller can grant itself that key, so the
 * tenant type gates it as well. A reseller's currency is in its workspace,
 * because its owner's session carries the platform tenant (invariant 21).
 */
export default function SettingsPage() {
  const { t } = useLocale();
  const { me } = usePanelSession();
  const platformAdmin = me?.tenant.type === "platform_owner" && me.permissions.includes("tenant.manage");
  return (
    <div className="mx-auto w-full max-w-[560px] px-6 py-10">
      <h1 className="mb-6 text-xl font-bold text-text-primary">
        {t("common", FrontendI18nKeys.common.settings.title)}
      </h1>
      <EmailSection />
      <NotificationsSection />
      <MessengerSection />
      {platformAdmin && <OperatingCurrencyCard tenantId={me.tenant.id} scope="platform" />}
    </div>
  );
}
