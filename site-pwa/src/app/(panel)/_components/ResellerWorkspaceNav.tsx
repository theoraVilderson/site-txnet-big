"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ExternalLink, Store, UserRound, type LucideIcon } from "lucide-react";
import { CollapsedTooltip } from "./CollapsedTooltip";
import { authApi, type OwnedReseller } from "@/lib/auth-api";
import { useLocale } from "@/context/LocaleContext";
import { ApiError } from "@/lib/api-error";
import { AUTH_HANDOFF, PANEL_HOME, PANEL_RESELLER_SELF, resellerWorkspaceRoot } from "@/lib/routes";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { DURATION, EASE } from "@/lib/motion";
import { usePanelSession } from "../_context/PanelSessionContext";
import { workspaceOfPath, type Workspace } from "../_lib/reseller-menu";
import { resellerDomainOf, selfResellerOf, useOwnedResellerList } from "../my-resellers/_lib/workspace";

/** The switcher's and the reseller menu's strings (UX-2-a, C-06). */
const K = FrontendI18nKeys.common.resellerNav;

/** What the sidebar needs to know about the caller's reseller workspaces. */
export interface ResellerWorkspaceNav {
  /** The workspace the address is inside — its menu is drawn — or `null`: the account's. */
  workspace: Workspace | null;
  /** The caller's owned resellers (`GET /auth/handoff`); `null` until it answers. */
  owned: readonly OwnedReseller[] | null;
  /** Where "my reseller" goes; `null` draws no switcher. */
  target: string | null;
  /** On a reseller's own domain: no handoff, nowhere to hand off to (F-061-m). */
  onResellerDomain: boolean;
}

/**
 * The address picks the menu (UX-2-a): nothing is stored. A workspace is drawn
 * only where its screens are — on the platform's panel by id, and on a
 * reseller's domain at its own `/reseller` (a `/my-resellers` address there is
 * the panel's 404, `PlatformOnlyWorkspace`). Until `me` and the owned list
 * answer, the account's menu stands and no switcher is drawn.
 */
export function useResellerWorkspace(): ResellerWorkspaceNav {
  const { me } = usePanelSession();
  const pathname = usePathname() ?? "";
  const owned = useOwnedResellerList();
  const selfId = selfResellerOf(me, owned);
  const domain = resellerDomainOf(me, owned);
  const inPath = me ? workspaceOfPath(pathname, me, selfId) : null;
  const workspace = inPath && (inPath.self || domain === null) ? inPath : null;
  let target: string | null = null;
  if (workspace) target = resellerWorkspaceRoot(workspace.id, workspace.self);
  else if (typeof selfId === "string") target = PANEL_RESELLER_SELF;
  // An owner whose one reseller is terminated still reaches it, by id.
  else if (domain === null && owned && owned.length > 0) target = resellerWorkspaceRoot(owned[0].id);
  return { workspace, owned, target, onResellerDomain: typeof domain === "string" };
}

/**
 * The workspace switcher (UX-2-a) at the top of the nav: "my account" and
 * "my reseller", one current. Under it, on the platform, an owner holding more
 * than one reseller (a terminated one beside the live one) picks which.
 */
export function WorkspaceSwitcher({ nav, collapsed }: { nav: ResellerWorkspaceNav; collapsed: boolean }) {
  const { t } = useLocale();
  if (!nav.target) return null;
  const inReseller = nav.workspace !== null;
  const others = inReseller && !nav.onResellerDomain && nav.owned && nav.owned.length > 1 ? nav.owned : [];
  const selfId = nav.owned?.find((r) => r.live)?.id;
  return (
    <div className="mb-3 space-y-2 border-b border-card-border pb-3">
      <nav
        aria-label={t("common", K.switcher.label)}
        className={`grid gap-1 rounded-xl border border-card-border p-1 grid-cols-2 ${collapsed ? "lg:grid-cols-1" : ""}`}
      >
        <Segment href={PANEL_HOME} current={!inReseller} icon={UserRound} label={t("common", K.switcher.account)} collapsed={collapsed} />
        <Segment href={nav.target} current={inReseller} icon={Store} label={t("common", K.switcher.reseller)} collapsed={collapsed} />
      </nav>
      {others.length > 0 && (
        <ul aria-label={t("common", K.others)} className={`space-y-0.5 ${collapsed ? "lg:hidden" : ""}`}>
          {others.map((r) => {
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
      )}
    </div>
  );
}

function Segment({
  href,
  current,
  icon: Icon,
  label,
  collapsed,
}: {
  href: string;
  current: boolean;
  icon: LucideIcon;
  label: string;
  collapsed: boolean;
}) {
  return (
    <Link
      href={href}
      // The current workspace, not the current page: "true", not "page".
      aria-current={current ? "true" : undefined}
      className={`group relative isolate flex items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm font-medium transition-colors duration-200 ${
        current ? "text-on-accent" : "text-text-secondary hover:text-text-primary"
      }`}
    >
      {current && (
        <motion.span
          layoutId="workspace-switcher-current"
          aria-hidden
          transition={{ duration: DURATION.base, ease: EASE.standard }}
          className="absolute inset-0 -z-10 rounded-lg bg-primary"
        />
      )}
      <Icon size={16} aria-hidden className="shrink-0" />
      <span className={`truncate ${collapsed ? "lg:sr-only" : ""}`}>{label}</span>
      <CollapsedTooltip collapsed={collapsed} label={label} />
    </Link>
  );
}

/**
 * "Open my panel" (the handoff, F-061-f), drawn in the reseller menu's home
 * section: only on the platform, only for a reseller the caller owns, and
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
 * service leaves the visitor where they were. Shared by the reseller menu and
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
