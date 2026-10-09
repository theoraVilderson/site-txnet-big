import { Bot, Contact, Globe, KeyRound, Landmark, ListChecks, Package, Palette, Settings2, Store, UserCog, type LucideIcon } from "lucide-react";
import type { Me } from "@/lib/auth-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import {
  PANEL_MY_RESELLERS,
  PANEL_RESELLER_SELF,
  PANEL_ROLES,
  PANEL_TEAM,
  PANEL_USERS,
  resellerWorkspaceRoot,
  myResellerBotPath,
  myResellerBrandingPath,
  myResellerCatalogPath,
  myResellerConsolePath,
  myResellerDomainsPath,
  myResellerGatewaysPath,
  myResellerRolesPath,
  myResellerTeamPath,
  myResellerSettingsPath,
  myResellerSetupPath,
  myResellerUsersPath,
} from "@/lib/routes";
import type { SetupProgress } from "../my-resellers/_lib/setup";
import { menuHrefs, type MenuSectionId, type PanelMenuGroup, type PanelMenuLink, type VisibleMenuEntry, type VisibleMenuGroup } from "./panel-menu";

/** The reseller menu's strings as generated constants (C-06). */
const R = FrontendI18nKeys.common.resellerNav;

interface ResellerMenuLink extends PanelMenuLink {
  /** The label inside the "reseller" button, which already says whose. */
  short: string;
  href: (id: string, self: boolean) => string;
}

/**
 * One reseller's workspace in the account's menu: **one "reseller" button in
 * `account` that opens to its pages** (user, 2026-10-08 — first merged into
 * the sections they belong to, which spread "reseller …" and a slug over
 * five sections). In working order: home, then what a shop needs (catalog,
 * gateways, users, domains, bot), then brand and settings. Gateways are only
 * those it sells with — its billing with the platform is the session's
 * tenant (`PANEL_TENANT_BILLING`). The handoff is not an entry: the sidebar
 * draws it after them, inside (`contract.reseller-workspace.md`).
 */
export const RESELLER_MENU: readonly ResellerMenuLink[] = [
  { id: "reseller-home", label: R.menu.home, short: R.short.home, icon: Store, href: myResellerConsolePath },
  { id: "reseller-catalog", label: R.menu.catalog, short: R.short.catalog, icon: Package, href: myResellerCatalogPath },
  { id: "reseller-gateways", label: R.menu.gateways, short: R.short.gateways, icon: Landmark, href: myResellerGatewaysPath },
  { id: "reseller-users", label: R.menu.users, short: R.short.users, icon: UserCog, href: myResellerUsersPath },
  { id: "reseller-team", label: R.menu.team, short: R.short.team, icon: Contact, href: myResellerTeamPath },
  { id: "reseller-roles", label: R.menu.roles, short: R.short.roles, icon: KeyRound, href: myResellerRolesPath },
  { id: "reseller-domains", label: R.menu.domains, short: R.short.domains, icon: Globe, href: myResellerDomainsPath },
  { id: "reseller-bot", label: R.menu.bot, short: R.short.bot, icon: Bot, href: myResellerBotPath },
  { id: "reseller-branding", label: R.menu.branding, short: R.short.branding, icon: Palette, href: myResellerBrandingPath },
  { id: "reseller-settings", label: R.menu.settings, short: R.short.settings, icon: Settings2, href: myResellerSettingsPath },
];

/**
 * The setup wizard's row (UX-2-e): after the home, carrying the route's
 * count, and only while setup is not complete — not a `RESELLER_MENU` row,
 * because a finished reseller has nothing there to open.
 */
export const RESELLER_SETUP_LINK: ResellerMenuLink = {
  id: "reseller-setup",
  label: R.menu.setup,
  short: R.short.setup,
  icon: ListChecks,
  href: myResellerSetupPath,
};

/** The button's id; one at a time is open, like any group (N2). */
export const RESELLER_GROUP_ID = "reseller";

/** The same button as menu data, for the breadcrumb: "my account › reseller › …" (UX-2-a2). */
export const RESELLER_MENU_GROUP: PanelMenuGroup & { section: MenuSectionId } = {
  id: RESELLER_GROUP_ID,
  section: "account",
  label: R.scope,
  icon: Store,
  children: [RESELLER_MENU[0], RESELLER_SETUP_LINK, ...RESELLER_MENU.slice(1)],
};

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

/**
 * {@link RESELLER_MENU} for one workspace, as the one button: whose it is
 * (`tag`, the slug when known) and, until setup is complete, the setup row
 * after the home and its count on the button itself (UX-2-e).
 */
export function resellerMenu(
  ws: Workspace,
  slug: string | null = null,
  setup: SetupProgress | null = null,
): VisibleMenuGroup & { section: MenuSectionId } {
  const open = setup && !setup.complete ? setup : null;
  const rows = RESELLER_MENU.flatMap((row) => (row.id === "reseller-home" && open ? [row, RESELLER_SETUP_LINK] : [row]));
  const progress = open ? { done: open.done, total: open.total } : undefined;
  return {
    id: RESELLER_GROUP_ID,
    section: "account",
    label: R.scope,
    icon: Store,
    tag: slug ?? undefined,
    progress,
    children: rows.map(({ href, ...link }) => ({
      ...link,
      href: href(ws.id, ws.self),
      ...(link.id === RESELLER_SETUP_LINK.id ? { progress } : {}),
    })),
  };
}

/**
 * The account's menu with the reseller's button after its own entries. A
 * page the account's menu already holds is not drawn twice: on a reseller's
 * staff seat (F-311-ab) the workspace is the session's own tenant
 * (`ownTenantId`), so its `/reseller/users` is the account's `/users` — and
 * the same for the team and the roles.
 */
export function withResellerMenu(
  menu: readonly VisibleMenuEntry[],
  ws: Workspace | null,
  slug: string | null = null,
  setup: SetupProgress | null = null,
  ownTenantId: string | null = null,
): VisibleMenuEntry[] {
  if (!ws) return [...menu];
  const held = new Set(menuHrefs(menu));
  if (ws.id === ownTenantId)
    for (const own of [PANEL_USERS, PANEL_TEAM, PANEL_ROLES])
      if (held.has(own)) held.add(`${resellerWorkspaceRoot(ws.id, ws.self)}${own}`);
  const group = resellerMenu(ws, slug, setup);
  return [...menu, { ...group, children: group.children.filter((l) => !held.has(l.href)) }];
}
