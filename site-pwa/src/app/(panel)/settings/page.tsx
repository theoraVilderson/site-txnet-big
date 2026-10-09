"use client";

import { Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { Settings } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ManualRateCard } from "../_components/ManualRateCard";
import { OperatingCurrencyCard } from "../_components/OperatingCurrencyCard";
import { TenantTimeZoneCard } from "../_components/TenantTimeZoneCard";
import { PageHeader } from "../_components/kit/PageHeader";
import { Tabs } from "../_components/kit/Tabs";
import { usePanelSession } from "../_context/PanelSessionContext";
import { AppearanceSection } from "./_components/AppearanceSection";
import { EmailSection } from "./_components/EmailSection";
import { canPinRates, canSetPlatformCurrency, settingsTabs, type SettingsTab } from "./_lib/settings";
import { MessengerSection } from "./_components/MessengerSection";
import { NotificationsSection } from "./_components/NotificationsSection";
import { ProfileSection } from "./_components/ProfileSection";
import { SessionsSection } from "./_components/SessionsSection";
import { TimeZoneSection } from "./_components/TimeZoneSection";

/**
 * The user's settings on tabs (UX-1-s, `contract.ux.md` S1–S2), `?tab=`:
 *
 * - `profile` — the name edited in place and the password (UX-1-u), the email
 *   address (F-035-j) and every place the account is signed in (SES-1-b);
 * - `notifications` — which service notices they are told and quiet hours
 *   (F-601-m), and which messenger tells them (F-601-u);
 * - `appearance` — theme, language, their time zone (TZ-1-e) and the motion
 *   level (`ui.motion`, UX-1-l);
 * - `workspace` — the platform's operating currency (F-116-h) and time zone,
 *   for its staff with `settings.manage` (or `*`) only: a reseller can grant
 *   itself that key, so the tenant type gates it as well. A reseller's
 *   currency is in its workspace, because its owner's session carries the
 *   platform tenant (invariant 21). The manual-rate card (F-116-l) is here for
 *   anyone holding `currency.pin`, on either kind of tenant: the pin routes
 *   scope to the session's own books.
 *
 * A tab is mounted the first time it is opened and stays mounted, hidden, so
 * an unsaved form — and its `SaveBar` — survives a switch to another tab.
 *
 * The tabs read `?tab=` with `useSearchParams`, and Next will not prerender a
 * page that does without a `Suspense` boundary over it (as `financial/page.tsx`).
 */
export default function SettingsPage() {
  const { t } = useLocale();
  const { me } = usePanelSession();
  const tabs = settingsTabs(me);
  const [visited, setVisited] = useState<ReadonlySet<SettingsTab>>(new Set());
  const visit = useCallback((tab: SettingsTab) => setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab))), []);

  const panels: Record<SettingsTab, () => ReactNode> = {
    profile: () => (
      <>
        <ProfileSection />
        <EmailSection />
        <SessionsSection />
      </>
    ),
    notifications: () => (
      <>
        <NotificationsSection />
        <MessengerSection />
      </>
    ),
    appearance: () => (
      <>
        <AppearanceSection />
        <TimeZoneSection />
      </>
    ),
    workspace: () =>
      me && (
        <>
          {canSetPlatformCurrency(me) && <OperatingCurrencyCard tenantId={me.tenant.id} scope="platform" />}
          {canSetPlatformCurrency(me) && <TenantTimeZoneCard tenantId={me.tenant.id} scope="platform" />}
          {canPinRates(me) && <ManualRateCard scope={me.tenant.type === "platform_owner" ? "platform" : "reseller"} />}
        </>
      ),
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <PageHeader title={t("common", FrontendI18nKeys.common.settings.title)} icon={Settings} />
      <Suspense fallback={null}>
        <Tabs<SettingsTab>
          ariaLabel={t("common", FrontendI18nKeys.common.settings.tabs.label)}
          tabs={tabs.map((tab) => ({ value: tab.value, label: t("common", tab.label) }))}
          urlParam="tab"
          variant="side"
          className="mt-6"
        >
          {(active) => (
            <div className="max-w-3xl space-y-6">
              <Visited tab={active} onVisit={visit} />
              {tabs
                .filter((tab) => tab.value === active || visited.has(tab.value))
                .map((tab) => (
                  <div key={tab.value} hidden={tab.value !== active} className="space-y-6">
                    {panels[tab.value]()}
                  </div>
                ))}
            </div>
          )}
        </Tabs>
      </Suspense>
    </div>
  );
}

/** Remembers each tab opened, so it stays mounted once left. */
function Visited({ tab, onVisit }: { tab: SettingsTab; onVisit: (tab: SettingsTab) => void }) {
  useEffect(() => onVisit(tab), [tab, onVisit]);
  return null;
}
