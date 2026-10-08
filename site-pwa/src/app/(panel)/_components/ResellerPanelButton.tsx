"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ExternalLink, Settings2, Store } from "lucide-react";
import { CollapsedTooltip } from "./CollapsedTooltip";
import { authApi, type OwnedReseller } from "@/lib/auth-api";
import { useLocale } from "@/context/LocaleContext";
import { ApiError } from "@/lib/api-error";
import { AUTH_HANDOFF, PANEL_RESELLER_SELF, myResellerConsolePath } from "@/lib/routes";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { usePanelSession } from "../_context/PanelSessionContext";
import { resellerDomainOf, selfResellerOf, useOwnedResellerList } from "../my-resellers/_lib/workspace";

/** The sidebar's reseller block (F-061-n, C-06). */
const K = FrontendI18nKeys.common.resellerNav;

type Reseller = Pick<OwnedReseller, "id" | "slug"> & Partial<Pick<OwnedReseller, "here" | "hasPanel" | "live">>;

/**
 * The sidebar's "my reseller" block (F-061-n), at the top of the nav. Two
 * things an owner does with a reseller, never folded into one click again:
 *
 * - **Reseller settings** — its workspace: users, catalog, gateways, domains,
 *   bot, brand (ADR-0064 (4)). The owner's live reseller at the id-less
 *   `/reseller`, on its domain and on the platform's panel alike; a
 *   terminated one it still holds by id, `/my-resellers/:id`.
 * - **Open its panel** — the handoff (F-061-f): a single-use code spent on its
 *   own domain, because the refresh cookie is host-only (ADR-0060 (4)). Only
 *   on the platform, and only enabled where it lands (`hasPanel`); otherwise
 *   the line under it says to connect a domain first, instead of the click
 *   being refused and silently opening the settings.
 *
 * On a reseller's domain the block is that reseller's alone, offered to its
 * owner — whose session there is the platform's tenant, so `here` says it —
 * and to a staff seat holding `tenant.manage` (invariant 21). Renders
 * nothing for anyone else, and nothing until `me` has answered.
 */
export function ResellerPanelButton({
  resellers,
  collapsed = false,
}: {
  resellers: readonly Reseller[] | null;
  collapsed?: boolean;
}) {
  const { t } = useLocale();
  const { me } = usePanelSession();
  const pathname = usePathname();
  const { pending, open } = useResellerPanelOpener();
  if (!me) return null;

  // On a reseller's own domain: its settings only. The owner's session there is
  // the platform's tenant, so the door's `here` says it (`resellerDomainOf`).
  const domain = resellerDomainOf(me, resellers);
  const self = selfResellerOf(me, resellers);
  if (domain === undefined || self === undefined) return null;
  if (domain !== null) {
    if (self !== domain) return null;
    return (
      <Block title={t("common", K.title)} collapsed={collapsed}>
        <SettingsLink href={PANEL_RESELLER_SELF} pathname={pathname} label={t("common", K.settings)} collapsed={collapsed} />
      </Block>
    );
  }
  if (me.tenant.type === "reseller") return null;

  if (!resellers || resellers.length === 0) return null;
  return (
    <Block title={t("common", K.title)} collapsed={collapsed}>
      {resellers.map((reseller) => {
        const openLabel = t("common", pending === reseller.id ? K.opening : K.open);
        const canOpen = reseller.hasPanel !== false;
        return (
          <div key={reseller.id} className="rounded-xl border border-card-border p-1.5">
            <p
              dir="ltr"
              className={`flex items-center gap-2 px-2 pb-1 pt-0.5 text-sm font-bold text-text-primary ${collapsed ? "lg:sr-only" : ""}`}
            >
              <Store size={16} aria-hidden className="shrink-0 text-primary" />
              <span className="truncate">{reseller.slug}</span>
            </p>
            <SettingsLink
              // Its own live reseller has no id in the address, here too (F-061-n).
              href={reseller.id === self ? PANEL_RESELLER_SELF : myResellerConsolePath(reseller.id)}
              pathname={pathname}
              label={t("common", K.settings)}
              collapsed={collapsed}
            />
            <button
              type="button"
              onClick={() => open(reseller.id)}
              disabled={!canOpen || pending !== null}
              aria-describedby={canOpen ? undefined : `reseller-nopanel-${reseller.id}`}
              className={`group relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-secondary transition-colors duration-200 enabled:hover:bg-leaf-bg enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60 ${
                collapsed ? "lg:justify-center" : ""
              }`}
            >
              <ExternalLink size={18} className="shrink-0 rtl:-scale-x-100" aria-hidden />
              <span className={`flex-1 truncate text-start font-medium ${collapsed ? "lg:sr-only" : ""}`}>{openLabel}</span>
              <CollapsedTooltip collapsed={collapsed} label={openLabel} />
            </button>
            {!canOpen && (
              <p
                id={`reseller-nopanel-${reseller.id}`}
                className={`px-3 pb-1 text-xs text-text-secondary ${collapsed ? "lg:sr-only" : ""}`}
              >
                {t("common", K.noPanel)}
              </p>
            )}
          </div>
        );
      })}
    </Block>
  );
}

function Block({ title, collapsed, children }: { title: string; collapsed: boolean; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="mb-2 space-y-1.5 border-b border-card-border pb-3">
      <p
        aria-hidden
        className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-text-secondary ${collapsed ? "lg:sr-only" : ""}`}
      >
        {title}
      </p>
      {children}
    </section>
  );
}

/** Current anywhere inside the workspace, the way a group lights for its pages. */
function SettingsLink({
  href,
  pathname,
  label,
  collapsed,
}: {
  href: string;
  pathname: string;
  label: string;
  collapsed: boolean;
}) {
  const current = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={`group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-200 ${
        current ? "bg-leaf-bg font-bold text-primary" : "text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
      } ${collapsed ? "lg:justify-center" : ""}`}
    >
      <Settings2 size={18} className="shrink-0" aria-hidden />
      <span className={`flex-1 truncate font-medium ${collapsed ? "lg:sr-only" : ""}`}>{label}</span>
      <CollapsedTooltip collapsed={collapsed} label={label} />
    </Link>
  );
}

/**
 * The resellers the caller owns (`GET /auth/handoff`): `null` until it answers,
 * empty when it cannot be read. A terminated one is still listed, so this is
 * not "may buy another" — that is `GET /purchase/mine` (F-114-c).
 */
export function useOwnedResellers(): readonly OwnedReseller[] | null {
  // One read per account, shared with the workspace's guard and links.
  return useOwnedResellerList();
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
