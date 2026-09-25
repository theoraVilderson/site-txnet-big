"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Store } from "lucide-react";
import { CollapsedTooltip } from "./CollapsedTooltip";
import { authApi } from "@/lib/auth-api";
import { useLocale } from "@/context/LocaleContext";
import { ApiError } from "@/lib/api-error";
import { AUTH_HANDOFF, myResellerConsolePath } from "@/lib/routes";
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
 * A reseller with no panel domain of its own has nowhere to be handed to, and
 * the handoff refuses it (`auth.handoffRefused`). The entry then opens its
 * onboarding console on this panel instead (F-066-w, ADR-0064 (4)) — which is
 * where such a reseller is configured. Only an answer that never arrived
 * leaves the visitor where they were.
 *
 * Renders nothing for a caller who owns no reseller, and nothing if the list
 * cannot be read: it is a shortcut, never a reason to break the sidebar. The
 * list is `useOwnedResellers`', read once by the sidebar, which also hides
 * "become a reseller" from a caller it names (F-114-c).
 */
export function ResellerPanelButton({
  resellers,
  collapsed = false,
}: {
  resellers: readonly Reseller[] | null;
  collapsed?: boolean;
}) {
  const { t } = useLocale();
  const { pending, open } = useResellerPanelOpener();

  return (
    <>
      {(resellers ?? []).map((reseller) => {
        const label = t("common", pending === reseller.id ? C.openingResellerPanel : C.resellerPanel, {
          slug: reseller.slug,
        });
        return (
          <button
            key={reseller.id}
            type="button"
            onClick={() => open(reseller.id)}
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

/**
 * The resellers the caller owns (`GET /auth/handoff`): `null` until it answers.
 * A list that cannot be read is empty — the entry this hides is an invitation
 * the purchase page itself answers for a holder (F-019-l), so a lost answer
 * costs nothing but a shortcut.
 */
export function useOwnedResellers(): readonly Reseller[] | null {
  const [resellers, setResellers] = useState<Reseller[] | null>(null);
  useEffect(() => {
    let live = true;
    authApi
      .ownedResellers()
      .then((r) => live && setResellers(r.resellers))
      .catch(() => live && setResellers([]));
    return () => {
      live = false;
    };
  }, []);
  return resellers;
}

/**
 * Opens one reseller's own panel, signed in as the same account: mint a
 * handoff code and spend it on its origin. An answered refusal — it has no
 * panel host — opens its console here instead (F-066-w); only an unreachable
 * service leaves the visitor where they were. Shared by the sidebar entry and
 * `/resellers/buy`'s held state (F-019-l), so the two never disagree.
 */
export function useResellerPanelOpener() {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const open = async (tenantId: string) => {
    setPending(tenantId);
    try {
      const { origin, code } = await authApi.issueHandoff(tenantId);
      window.location.assign(`${origin}${AUTH_HANDOFF}#${code}`);
    } catch (e) {
      setPending(null);
      if (e instanceof ApiError && !e.unreachable) router.push(myResellerConsolePath(tenantId));
    }
  };
  return { pending, open };
}
