"use client";

import { Home, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { PANEL_HOME } from "@/lib/routes";
import { Card } from "./kit/Card";

const S = FrontendI18nKeys.common.shell.accessLost;

/**
 * "You no longer have access to this page" (AC-1-r), in the page's place, when
 * the person's access moved while the page was open and its menu entry went
 * with it (`useAccessLost`). The shell around it still works; the menu already
 * shows what is held now.
 */
export function AccessLostNotice() {
  const { t } = useLocale();
  return (
    <div className="mx-auto flex w-full max-w-xl p-4 md:p-8">
      <Card role="alert" className="flex w-full flex-col items-center gap-4 text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-error-bg text-error">
          <LockKeyhole size={28} aria-hidden />
        </span>
        <div>
          <h1 className="text-lg font-bold text-text-primary">{t("common", S.title)}</h1>
          <p className="mt-1 text-sm leading-6 text-text-secondary">{t("common", S.body)}</p>
        </div>
        <Link
          href={PANEL_HOME}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-card-border bg-card-bg px-4 text-sm font-bold text-text-primary hover:border-primary hover:bg-leaf-bg"
        >
          <Home size={16} aria-hidden />
          {t("common", S.home)}
        </Link>
      </Card>
    </div>
  );
}
