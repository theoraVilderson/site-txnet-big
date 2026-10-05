"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { PANEL_ACCOUNTS_ADD } from "@/lib/routes";
import { usePanelSession } from "../../../_context/PanelSessionContext";

const C = FrontendI18nKeys.common;

/**
 * "Accounts in this browser" (UX-1-p, D2): the switch group the dashboard
 * showed alone before it had widgets. It stays, because a switcher whose
 * effect is invisible cannot be verified by the person using it (F-0209).
 */
export default function AccountsWidget() {
  const { t } = useLocale();
  const { group } = usePanelSession();
  if (!group) return null;
  return (
    <div className="flex h-full flex-col">
      {group.members.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", C.accounts.groupEmpty)}</p>
      ) : (
        <ul className="space-y-2">
          {group.members.map((member) => (
            <li key={member.userId} className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-text-primary">{member.fullName}</span>
              <span className="shrink-0 text-text-secondary" dir="ltr">
                {member.phoneMasked}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Link href={PANEL_ACCOUNTS_ADD} className="mt-auto inline-flex items-center gap-2 pt-4 text-sm font-bold text-primary">
        <Plus size={16} aria-hidden />
        {t("common", C.accounts.add)}
      </Link>
    </div>
  );
}
