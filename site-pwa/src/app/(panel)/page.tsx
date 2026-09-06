"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { PANEL_ACCOUNTS_ADD } from "@/lib/routes";
import { usePanelSession } from "./_context/PanelSessionContext";

/**
 * The panel home. Until there is a product surface here it says the one thing
 * a switch changes — which account this browser is — because a switcher whose
 * effect is invisible cannot be verified by the person using it (F-0209).
 */
export default function Home() {
  const { t } = useLocale();
  const { group, isLoading } = usePanelSession();

  if (isLoading || !group) {
    return (
      <div className="mx-auto w-full max-w-[560px] px-6 py-10">
        <div className="h-24 animate-pulse rounded-2xl bg-bg-inner" aria-hidden />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[560px] px-6 py-10">
      <p className="mb-1 text-sm text-text-secondary">
        {t("common", "accounts.signedInAs")}
      </p>
      <h1 className="text-2xl font-bold text-text-primary">
        {group.current.fullName}
      </h1>
      <p className="mt-1 text-sm text-text-secondary" dir="ltr">
        {group.current.phoneMasked}
      </p>

      <div className="mt-8 rounded-2xl border border-card-border bg-card-bg p-5">
        <h2 className="mb-3 text-sm font-bold text-text-primary">
          {t("common", "accounts.groupTitle")}
        </h2>
        {group.members.length === 0 ? (
          <p className="text-sm text-text-secondary">
            {t("common", "accounts.groupEmpty")}
          </p>
        ) : (
          <ul className="space-y-2">
            {group.members.map((member) => (
              <li
                key={member.userId}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="truncate text-text-primary">
                  {member.fullName}
                </span>
                <span className="shrink-0 text-text-secondary" dir="ltr">
                  {member.phoneMasked}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Link
          href={PANEL_ACCOUNTS_ADD}
          className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-primary"
        >
          <Plus size={16} />
          {t("common", "accounts.add")}
        </Link>
      </div>
    </div>
  );
}
