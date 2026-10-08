import { Bot, Globe, Landmark, Package, Palette, Settings2, Store, UserCog, type LucideIcon } from "lucide-react";
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
import { menuHrefs, type MenuSectionId, type VisibleMenuEntry, type VisibleMenuLink } from "./panel-menu";

/** The reseller menu's strings as generated constants (C-06). */
const R = FrontendI18nKeys.common.resellerNav;

interface ResellerMenuLink {
  /** The account menu's section it joins (N1) — one menu, not a second one. */
  section: MenuSectionId;
  id: string;
  /** A `common` namespace key. */
  label: string;
  icon: LucideIcon;
  href: (id: string, self: boolean) => string;
}

/**
 * One reseller's workspace, merged into the account's menu (UX-2-a; user,
 * 2026-10-08: one menu, the reseller's pages in the sections they belong to,
 * not a switcher). Home, settings and brand join `account`; the catalog
 * `sales`; gateways `finance` — only those: the reseller's billing with the
 * platform is the session's tenant (`PANEL_TENANT_BILLING`), not the path's;
 * users `people`; domains and the bot `infra`. The handoff is not an entry —
 * the sidebar draws it after them in `account` (`contract.reseller-workspace.md`).
 */
export const RESELLER_MENU: readonly ResellerMenuLink[] = [
  { section: "account", id: "reseller-home", label: R.menu.home, icon: Store, href: myResellerConsolePath },
  { section: "account", id: "reseller-settings", label: R.menu.settings, icon: Settings2, href: myResellerSettingsPath },
  { section: "account", id: "reseller-branding", label: R.menu.branding, icon: Palette, href: myResellerBrandingPath },
  { section: "sales", id: "reseller-catalog", label: R.menu.catalog, icon: Package, href: myResellerCatalogPath },
  { section: "finance", id: "reseller-gateways", label: R.menu.gateways, icon: Landmark, href: myResellerGatewaysPath },
  { section: "people", id: "reseller-users", label: R.menu.users, icon: UserCog, href: myResellerUsersPath },
  { section: "infra", id: "reseller-domains", label: R.menu.domains, icon: Globe, href: myResellerDomainsPath },
  { section: "infra", id: "reseller-bot", label: R.menu.bot, icon: Bot, href: myResellerBotPath },
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

/** {@link RESELLER_MENU} for one workspace: links placed in the account's sections. */
export function resellerMenu(ws: Workspace): (VisibleMenuLink & { section: MenuSectionId })[] {
  return RESELLER_MENU.map(({ href, ...link }) => ({ ...link, href: href(ws.id, ws.self) }));
}

/**
 * The account's menu with the reseller's links merged in, each after the
 * account's own entries of its section (`menuSections` keeps that order). A
 * link the account's menu already holds — `/reseller/users` for a reseller's
 * staff seat (F-311-ab) — is not drawn twice.
 */
export function withResellerMenu(menu: readonly VisibleMenuEntry[], ws: Workspace | null): VisibleMenuEntry[] {
  if (!ws) return [...menu];
  const held = new Set(menuHrefs(menu));
  return [...menu, ...resellerMenu(ws).filter((l) => !held.has(l.href))];
}
