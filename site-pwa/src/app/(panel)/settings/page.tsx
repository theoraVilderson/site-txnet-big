"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { EmailSection } from "./_components/EmailSection";
import { NotificationsSection } from "./_components/NotificationsSection";

/**
 * The user's own account settings: the email address (F-035-j), then which
 * service notices they are told and their quiet hours (F-601-m). The
 * sidebar's `settings` entry points here.
 */
export default function SettingsPage() {
  const { t } = useLocale();
  return (
    <div className="mx-auto w-full max-w-[560px] px-6 py-10">
      <h1 className="mb-6 text-xl font-bold text-text-primary">
        {t("common", FrontendI18nKeys.common.settings.title)}
      </h1>
      <EmailSection />
      <NotificationsSection />
    </div>
  );
}
