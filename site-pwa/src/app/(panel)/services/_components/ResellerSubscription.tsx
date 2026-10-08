"use client";

import Link from "next/link";
import { Store } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { myResellerConsolePath } from "@/lib/routes";
import { buttonClass } from "../../_components/kit";
import { formatInstant } from "../../_lib/datetime";
import { useOwnedReseller } from "../_hooks/useOwnedReseller";
import { SUBSCRIPTION_TONES, subscriptionState } from "../_lib/reseller-subscription";

const R = FrontendI18nKeys.common.myServices.reseller;

/**
 * The caller's reseller subscription, its own section above the Grants and
 * never a row of their list (F-502-v, `contract.reseller-subscription.md`):
 * a reseller is not a Grant — it has no configs, link or traffic — and a
 * buyer holding one and no service saw an empty page. Its slug, package,
 * period end and state, and a link into the reseller menu.
 */
export function ResellerSubscription() {
  const { t, lang } = useLocale();
  const reseller = useOwnedReseller();
  if (!reseller) return null;
  const state = subscriptionState(reseller, Date.now());
  if (!state) return null;
  const end = reseller.currentPeriodEnd
    ? (formatInstant(reseller.currentPeriodEnd, lang, { withTime: false }) ?? reseller.currentPeriodEnd)
    : null;

  return (
    <section aria-labelledby="my-reseller-title" className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="my-reseller-title" className="text-sm font-bold text-text-primary">{t("common", R.title)}</h2>
          <p dir="ltr" className="mt-0.5 truncate text-start text-sm text-text-secondary">{reseller.slug}</p>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-bold ${SUBSCRIPTION_TONES[state]}`}>
          {t("common", R.state[state])}
        </span>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-text-secondary">{t("common", R.package)}</dt>
          <dd className="mt-0.5 font-medium text-text-primary">{reseller.package?.name ?? t("common", R.noPackage)}</dd>
        </div>
        {end && (
          <div>
            <dt className="text-xs text-text-secondary">{t("common", state === "active" ? R.periodEnd : R.periodEnded)}</dt>
            <dd className="mt-0.5 font-medium text-text-primary">{end}</dd>
          </div>
        )}
      </dl>
      <p className="text-xs leading-5 text-text-secondary">{t("common", R.hint[state])}</p>
      <Link href={myResellerConsolePath(reseller.id, false)} className={buttonClass({ variant: "primary", size: "sm" })}>
        <Store size={16} aria-hidden />
        {t("common", R.open)}
      </Link>
    </section>
  );
}
