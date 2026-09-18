"use client";

import { useEffect, useState } from "react";
import { Store } from "lucide-react";
import { CollapsedTooltip } from "./CollapsedTooltip";
import { authApi } from "@/lib/auth-api";
import { useLocale } from "@/context/LocaleContext";
import { AUTH_HANDOFF } from "@/lib/routes";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The `common` namespace as generated constants (F-083, C-06). */
const C = FrontendI18nKeys.common;

type Reseller = { id: string; slug: string };

/**
 * "My reseller panel" (F-061-f): one entry per reseller the caller owns, which
 * opens that reseller's own domain already signed in as the same account.
 *
 * The session cannot follow on its own — the refresh cookie is host-only
 * (ADR-0060 (4)) — so a click mints a single-use code here and the reseller's
 * domain spends it at `AUTH_HANDOFF`. The code rides in the fragment, which no
 * request, log line or `Referer` carries.
 *
 * Renders nothing for a caller who owns no reseller, and nothing if the list
 * cannot be read: it is a shortcut, never a reason to break the sidebar.
 */
export function ResellerPanelButton({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useLocale();
  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    authApi
      .ownedResellers()
      .then((r) => live && setResellers(r.resellers))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const open = async (reseller: Reseller) => {
    setPending(reseller.id);
    try {
      const { origin, code } = await authApi.issueHandoff(reseller.id);
      window.location.assign(`${origin}${AUTH_HANDOFF}#${code}`);
    } catch {
      setPending(null);
    }
  };

  return (
    <>
      {resellers.map((reseller) => {
        const label = t("common", pending === reseller.id ? C.openingResellerPanel : C.resellerPanel, {
          slug: reseller.slug,
        });
        return (
          <button
            key={reseller.id}
            type="button"
            onClick={() => open(reseller)}
            disabled={pending !== null}
            className={`group relative flex w-full items-center gap-3 rounded-xl px-3 py-3 text-text-secondary transition-colors duration-200 hover:bg-leaf-bg hover:text-text-primary disabled:opacity-60 ${
              collapsed ? "lg:justify-center" : ""
            }`}
          >
            <Store size={22} className="shrink-0" aria-hidden />
            <span className={`flex-1 truncate text-start font-medium ${collapsed ? "lg:sr-only" : ""}`}>
              {label}
            </span>
            <CollapsedTooltip collapsed={collapsed} label={label} />
          </button>
        );
      })}
    </>
  );
}
