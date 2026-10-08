"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { CollapsedTooltip } from "./CollapsedTooltip";
import { authApi, type OwnedReseller } from "@/lib/auth-api";
import { useLocale } from "@/context/LocaleContext";
import { ApiError } from "@/lib/api-error";
import { AUTH_HANDOFF, PANEL_RESELLER_SELF, resellerWorkspaceRoot } from "@/lib/routes";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { usePanelSession } from "../_context/PanelSessionContext";
import { workspaceOfPath, type Workspace } from "../_lib/reseller-menu";
import { resellerDomainOf, selfResellerOf, useOwnedResellerList } from "../my-resellers/_lib/workspace";

/** The reseller links' strings (UX-2-a, C-06). */
const K = FrontendI18nKeys.common.resellerNav;

/** What the sidebar needs to know about the caller's reseller workspaces. */
export interface ResellerWorkspaceNav {
  /** The reseller whose links the menu carries, or `null`: the account's menu alone. */
  workspace: Workspace | null;
  /** The caller's owned resellers (`GET /auth/handoff`); `null` until it answers. */
  owned: readonly OwnedReseller[] | null;
  /** On a reseller's own domain: no handoff, nowhere to hand off to (F-061-m). */
  onResellerDomain: boolean;
}

/**
 * Whose reseller links the one menu carries (UX-2-a): the workspace the
 * address is inside — staff opening a reseller by id see that one's — else
 * the caller's own (`/reseller`), else, for an owner whose one reseller is
 * terminated, that one by id. On a reseller's domain only its own `/reseller`
 * counts (a `/my-resellers` address there is the 404, `PlatformOnlyWorkspace`).
 * Until `me` and the owned list answer, the account's menu stands alone.
 */
export function useResellerWorkspace(): ResellerWorkspaceNav {
  const { me } = usePanelSession();
  const pathname = usePathname() ?? "";
  const owned = useOwnedResellerList();
  const selfId = selfResellerOf(me, owned);
  const domain = resellerDomainOf(me, owned);
  const inPath = me ? workspaceOfPath(pathname, me, selfId) : null;
  let workspace: Workspace | null = inPath && (inPath.self || domain === null) ? inPath : null;
  if (!workspace && typeof selfId === "string") workspace = { id: selfId, self: true };
  if (!workspace && domain === null && owned && owned.length > 0) workspace = { id: owned[0].id, self: false };
  return { workspace, owned, onResellerDomain: typeof domain === "string" };
}

/**
 * An owner holding more than one reseller (a terminated one beside the live
 * one), on the platform: one link per slug, after the reseller's links, picks
 * whose the menu carries.
 */
export function OtherResellers({ nav, collapsed }: { nav: ResellerWorkspaceNav; collapsed: boolean }) {
  const { t } = useLocale();
  if (nav.onResellerDomain || !nav.owned || nav.owned.length < 2) return null;
  const selfId = nav.owned.find((r) => r.live)?.id;
  return (
    <ul aria-label={t("common", K.others)} className={`space-y-0.5 ps-3 ${collapsed ? "lg:hidden" : ""}`}>
      {nav.owned.map((r) => {
        const current = r.id === nav.workspace?.id;
        return (
          <li key={r.id}>
            <Link
              href={resellerWorkspaceRoot(r.id, r.id === selfId)}
              aria-current={current ? "true" : undefined}
              dir="ltr"
              className={`block truncate rounded-lg px-3 py-1.5 text-sm ${
                current ? "bg-leaf-bg font-bold text-primary" : "text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
              }`}
            >
              {r.slug}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Open my panel" (the handoff, F-061-f), drawn after the reseller's links in
 * the account section: only on the platform, only for a reseller the caller owns, and
 * enabled only where it lands (`hasPanel`) — otherwise the line under it says
 * to connect a domain first, rather than a refused click.
 */
export function HandoffAction({ nav, collapsed }: { nav: ResellerWorkspaceNav; collapsed: boolean }) {
  const { t } = useLocale();
  const { pending, open } = useResellerPanelOpener();
  const reseller = nav.workspace && !nav.onResellerDomain ? nav.owned?.find((r) => r.id === nav.workspace?.id) : undefined;
  if (!reseller) return null;
  const label = t("common", pending === reseller.id ? K.opening : K.open);
  const canOpen = reseller.hasPanel !== false;
  return (
    <>
      <button
        type="button"
        onClick={() => open(reseller.id)}
        disabled={!canOpen || pending !== null}
        aria-describedby={canOpen ? undefined : `reseller-nopanel-${reseller.id}`}
        className={`group relative flex w-full items-center gap-3 rounded-xl px-3 py-3 text-text-secondary transition-colors duration-200 enabled:hover:bg-leaf-bg enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60 ${
          collapsed ? "lg:justify-center" : ""
        }`}
      >
        <ExternalLink size={22} className="shrink-0 rtl:-scale-x-100" aria-hidden />
        <span className={`flex-1 truncate text-start font-medium ${collapsed ? "lg:sr-only" : ""}`}>{label}</span>
        <CollapsedTooltip collapsed={collapsed} label={label} />
      </button>
      {!canOpen && (
        <p id={`reseller-nopanel-${reseller.id}`} className={`px-3 pb-1 text-xs text-text-secondary ${collapsed ? "lg:sr-only" : ""}`}>
          {t("common", K.noPanel)}
        </p>
      )}
    </>
  );
}

/**
 * Opens one reseller's own panel, signed in as the same account: mint a
 * handoff code and spend it on its origin. An answered refusal — it has no
 * panel host — opens its console here instead (F-066-w); only an unreachable
 * service leaves the visitor where they were. Shared by the sidebar and
 * `/resellers/buy`'s held state (F-019-l), so the two never disagree.
 */
export function useResellerPanelOpener() {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const open = async (tenantId: string, here = false) => {
    if (here) {
      router.push(PANEL_RESELLER_SELF);
      return;
    }
    setPending(tenantId);
    try {
      const { origin, code } = await authApi.issueHandoff(tenantId);
      window.location.assign(`${origin}${AUTH_HANDOFF}#${code}`);
    } catch (e) {
      setPending(null);
      // Its own workspace, at the address with no id (F-061-n); the guard sends any other there too.
      if (e instanceof ApiError && !e.unreachable) router.push(PANEL_RESELLER_SELF);
    }
  };
  return { pending, open };
}
