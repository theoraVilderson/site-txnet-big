import { Bot, Globe, Home, Landmark, Package, Palette, Settings2, UserCog, type LucideIcon } from "lucide-react";
import type { Me } from "@/lib/auth-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import {
  PANEL_MY_RESELLERS,
  PANEL_RESELLER_SELF,
  myResellerBotPath,
  myResellerBrandingPath,
  myResellerCatalogPath,
  myResellerConsolePath,
  myResellerDomainsPath,
  myResellerGatewaysPath,
  myResellerSettingsPath,
  myResellerUsersPath,
} from "@/lib/routes";
import type { VisibleMenuLink } from "./panel-menu";

/** The reseller menu's strings as generated constants (C-06). */
const R = FrontendI18nKeys.common.resellerNav;

/** UX-2-a's six sections, in its order. */
export const RESELLER_SECTIONS = [
  { id: "home", label: R.sections.home },
  { id: "sales", label: R.sections.sales },
  { id: "finance", label: R.sections.finance },
  { id: "customers", label: R.sections.customers },
  { id: "infra", label: R.sections.infra },
  { id: "settings", label: R.sections.settings },
] as const;

export type ResellerSectionId = (typeof RESELLER_SECTIONS)[number]["id"];

interface ResellerMenuLink {
  section: ResellerSectionId;
  id: string;
  /** A `common` namespace key. */
  label: string;
  icon: LucideIcon;
  href: (id: string, self: boolean) => string;
}

/**
 * One reseller's workspace as a menu (UX-2-a), every screen of ADR-0064 (4)
 * in the section it belongs to. Finance has gateways only: the reseller's
 * billing with the platform is the session's tenant (`PANEL_TENANT_BILLING`),
 * not the path's. The handoff is not an entry — the sidebar draws it in
 * `home`, where it lands (`contract.reseller-workspace.md`).
 */
export const RESELLER_MENU: readonly ResellerMenuLink[] = [
  { section: "home", id: "reseller-home", label: R.menu.home, icon: Home, href: myResellerConsolePath },
  { section: "sales", id: "reseller-catalog", label: R.menu.catalog, icon: Package, href: myResellerCatalogPath },
  { section: "finance", id: "reseller-gateways", label: R.menu.gateways, icon: Landmark, href: myResellerGatewaysPath },
  { section: "customers", id: "reseller-users", label: R.menu.users, icon: UserCog, href: myResellerUsersPath },
  { section: "infra", id: "reseller-domains", label: R.menu.domains, icon: Globe, href: myResellerDomainsPath },
  { section: "infra", id: "reseller-bot", label: R.menu.bot, icon: Bot, href: myResellerBotPath },
  { section: "settings", id: "reseller-settings", label: R.menu.settings, icon: Settings2, href: myResellerSettingsPath },
  { section: "settings", id: "reseller-branding", label: R.menu.branding, icon: Palette, href: myResellerBrandingPath },
];

/** A reseller's workspace: whose, and whether at its id-less address (F-061-n). */
export interface Workspace {
  id: string;
  self: boolean;
}

/**
 * Which workspace the address is inside, or `null` — the whole of "which menu"
 * (UX-2-a): nothing is stored. `/reseller/…` is the caller's own (`selfId`,
 * `selfResellerOf`; none while unknown or absent), `/my-resellers/:id/…` the
 * path's — except the platform's own users page, which shares that address
 * and is the account's (F-311-ab).
 */
export function workspaceOfPath(
  pathname: string,
  me: Pick<Me, "tenant"> | null,
  selfId: string | null | undefined,
): Workspace | null {
  const within = (root: string) => pathname === root || pathname.startsWith(`${root}/`);
  if (within(PANEL_RESELLER_SELF)) return typeof selfId === "string" ? { id: selfId, self: true } : null;
  if (!pathname.startsWith(`${PANEL_MY_RESELLERS}/`)) return null;
  const segment = pathname.slice(PANEL_MY_RESELLERS.length + 1).split("/")[0];
  if (!segment) return null;
  const id = decodeURIComponent(segment);
  if (me?.tenant.type === "platform_owner" && me.tenant.id === id) return null;
  // Its own, by id for a moment before the layout moves it to `/reseller` (F-061-n).
  return { id, self: id === selfId };
}

export interface ResellerMenuSection {
  id: ResellerSectionId;
  /** A `common` namespace key. */
  label: string;
  entries: VisibleMenuLink[];
}

/** {@link RESELLER_MENU} for one workspace, under its six headings. */
export function resellerMenu(ws: Workspace): ResellerMenuSection[] {
  return RESELLER_SECTIONS.map((s) => ({
    id: s.id,
    label: s.label,
    entries: RESELLER_MENU.filter((e) => e.section === s.id).map(({ section: _, href, ...link }) => ({
      ...link,
      href: href(ws.id, ws.self),
    })),
  })).filter((s) => s.entries.length > 0);
}
