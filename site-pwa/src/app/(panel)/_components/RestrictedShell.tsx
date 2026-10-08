"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { PANEL_SUPPORT, PANEL_SUPPORT_INBOX, PANEL_SUPPORT_SETTINGS } from "@/lib/routes";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { AccountSwitcher } from "./AccountSwitcher";
import { LogoutButton } from "./LogoutButton";

/** The `common` namespace as generated constants (F-083, C-06). */
const C = FrontendI18nKeys.common;

/**
 * The person's own support pages — the list and a thread — and nothing of the
 * agent's desk, which shares the `/support` prefix.
 */
export function isOwnSupportPath(path: string): boolean {
  if (path !== PANEL_SUPPORT && !path.startsWith(`${PANEL_SUPPORT}/`)) return false;
  return ![PANEL_SUPPORT_INBOX, PANEL_SUPPORT_SETTINGS].some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * The whole panel of a restricted account (ADR-0133): why, and their own
 * support conversations — nothing else.
 *
 * The server is the boundary (`auth-handler`'s allow-list, `AuthGuard`); this
 * frame exists so the person reads a reason instead of a wall of refusals.
 * Any other page is replaced by `/support`, and nothing of it is drawn on the
 * way. The switcher stays: another account of theirs may be whole.
 */
export function RestrictedShell({ reason, children }: { reason: string | null; children: React.ReactNode }) {
  const { t } = useLocale();
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const allowed = isOwnSupportPath(pathname);

  useEffect(() => {
    if (!allowed) router.replace(PANEL_SUPPORT);
  }, [allowed, router]);

  return (
    <div className="min-h-screen w-full">
      <header className="flex items-center justify-end gap-2 border-b border-card-border px-4 py-3">
        <AccountSwitcher />
        <div className="w-36">
          <LogoutButton />
        </div>
      </header>
      <section
        role="status"
        className="mx-auto mt-6 flex w-full max-w-3xl gap-3 rounded-2xl border border-warning-border bg-warning-bg px-5 py-4"
      >
        <ShieldAlert size={22} className="mt-0.5 shrink-0 text-warning" aria-hidden />
        <div className="space-y-1">
          <h1 className="font-bold text-text-primary">{t("common", C.restricted.title)}</h1>
          <p className="text-sm text-text-secondary">{t("common", C.restricted.body)}</p>
          {reason ? (
            <p className="text-sm text-text-primary">
              <span className="font-bold">{t("common", C.restricted.reason)}: </span>
              <span>{reason}</span>
            </p>
          ) : (
            <p className="text-sm text-text-secondary">{t("common", C.restricted.noReason)}</p>
          )}
        </div>
      </section>
      <main className="relative z-10 w-full">{allowed ? children : null}</main>
    </div>
  );
}
