import {
  BookOpen,
  CreditCard,
  Globe,
  Headphones,
  Home,
  Landmark,
  Package,
  ShieldCheck,
  ReceiptText,
  Settings,
  ShoppingCart,
  TicketPercent,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { PANEL_CATALOG, PANEL_COUPONS, PANEL_DEPOSIT, PANEL_FINANCIAL, PANEL_GATEWAYS, PANEL_HOME, PANEL_MANUAL_PAYMENTS, PANEL_SETTINGS } from "@/lib/routes";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The shell's menu labels as generated constants (C-06). */
const M = FrontendI18nKeys.common.shell.menu;

/**
 * Every RBAC permission key an entry needs before it is rendered — all of them,
 * the way `PermissionsGuard` requires all of them server-side. Absent is the
 * common case: a menu entry every signed-in user may see.
 *
 * This is where "no `admin` in the URL" lands in the browser (F-097, D-28).
 * There is one panel; an operator sees more of it because of what they hold,
 * never because of a path or a second app. The list is compared against the
 * `permissions` from `GET /auth/me`, which is the access token's own list — the
 * one `forward-auth` gates every request on — so an entry hidden here is an
 * entry the edge would have refused anyway.
 *
 * A permission is **not** always the whole answer: an operator-only surface
 * must also check `tenant.type === "platform_owner"`, because a reseller
 * administers its own roles and can grant itself the key
 * (`docs/domains/audit/contract.settlement.md`, invariant #9).
 */
type PermissionGated = { requires?: readonly string[] };

/**
 * The permission that stands for every other one — `SuperAdmin` holds it
 * instead of a list (F-101-d). The twin of shared-core's `ALL_PERMISSIONS`,
 * spelled again because this app has no path to shared-core (C-04). Only the
 * bare `*` is a wildcard.
 */
const ALL_PERMISSIONS = "*";

export interface PanelMenuLink extends PermissionGated {
  id: string;
  /** A `common` namespace key. */
  label: string;
  icon: LucideIcon;
  /**
   * `null` while the page does not exist. The entry is then hidden rather than
   * rendered as a dead link; the row that builds the page sets this to its
   * route constant, and `panel-menu.test.ts` checks the page is really there.
   */
  href: string | null;
}

export interface PanelMenuGroup extends PermissionGated {
  id: string;
  label: string;
  icon: LucideIcon;
  children: PanelMenuLink[];
}

export type PanelMenuEntry = PanelMenuLink | PanelMenuGroup;

export type VisibleMenuLink = PanelMenuLink & { href: string };
export type VisibleMenuGroup = Omit<PanelMenuGroup, "children"> & {
  children: VisibleMenuLink[];
};
export type VisibleMenuEntry = VisibleMenuLink | VisibleMenuGroup;

/**
 * Every entry the legacy panel's sidebar had (F-093-a), in its order. Most have
 * no page yet — see `href`.
 */
export const PANEL_MENU: readonly PanelMenuEntry[] = [
  { id: "dashboard", label: M.dashboard, icon: Home, href: PANEL_HOME },
  { id: "buy", label: M.buy, icon: ShoppingCart, href: null },
  { id: "my-services", label: M.myServices, icon: Globe, href: null },
  {
    id: "financial",
    label: M.financial,
    icon: Wallet,
    children: [
      // F-093-d
      { id: "financial-history", label: M.financialHistory, icon: ReceiptText, href: PANEL_FINANCIAL },
      // F-093-e
      { id: "deposit", label: M.deposit, icon: CreditCard, href: PANEL_DEPOSIT },
      // F-102-d. The permission hides it; what the page then shows is decided
      // by the tenant type, server-side (D-31).
      { id: "gateways", label: M.gateways, icon: Landmark, href: PANEL_GATEWAYS, requires: ["gateway.manage"] },
      // F-093-n. Like gateways: the permission hides it, billing scopes what it lists.
      { id: "manual-payments", label: M.manualPayments, icon: ShieldCheck, href: PANEL_MANUAL_PAYMENTS, requires: ["payment.confirm_manual"] },
      // F-502-g. Like gateways: the permission hides it, billing scopes what it lists (D-33).
      { id: "coupons", label: M.coupons, icon: TicketPercent, href: PANEL_COUPONS, requires: ["coupon.manage"] },
      // F-026-f. Like coupons: the permission hides it, billing scopes what it lists (D-34).
      { id: "catalog", label: M.catalog, icon: Package, href: PANEL_CATALOG, requires: ["catalog.manage"] },
    ],
  },
  { id: "tutorials", label: M.tutorials, icon: BookOpen, href: null },
  { id: "support", label: M.support, icon: Headphones, href: null },
  { id: "settings", label: M.settings, icon: Settings, href: PANEL_SETTINGS },
];

export function isMenuGroup<T extends PanelMenuEntry | VisibleMenuEntry>(
  entry: T,
): entry is Extract<T, { children: unknown }> {
  return "children" in entry;
}

/**
 * The menu as rendered: entries the caller may not see dropped, then links with
 * no page, then groups left with nothing in them.
 *
 * `held` is the `permissions` from `GET /auth/me`. It is a required argument
 * rather than an optional one on purpose — a default of "holds everything"
 * would make a forgotten call site render an operator's menu silently, and a
 * default of `[]` would hide a real entry just as silently. Passing it is one
 * line at the single call site (`PanelSidebar`), and the compiler asks for it.
 */
export function visibleMenu(
  entries: readonly PanelMenuEntry[],
  held: readonly string[],
): VisibleMenuEntry[] {
  const permitted = (e: PermissionGated) =>
    held.includes(ALL_PERMISSIONS) ||
    (e.requires ?? []).every((key) => held.includes(key));
  const hasPage = (l: PanelMenuLink): l is VisibleMenuLink => l.href !== null;
  const out: VisibleMenuEntry[] = [];
  for (const entry of entries) {
    if (!permitted(entry)) continue;
    if (isMenuGroup(entry)) {
      const children = entry.children.filter(
        (c) => permitted(c) && hasPage(c),
      ) as VisibleMenuLink[];
      if (children.length > 0) out.push({ ...entry, children });
    } else if (hasPage(entry)) {
      out.push(entry);
    }
  }
  return out;
}

/** Every href a visible menu links to, groups flattened. */
export function menuHrefs(entries: readonly VisibleMenuEntry[]): string[] {
  return entries.flatMap((e) =>
    isMenuGroup(e) ? e.children.map((c) => c.href) : [e.href],
  );
}

const trimSlash = (path: string) =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

/**
 * The one href to highlight for `pathname`: the longest menu href that is the
 * path itself or a whole-segment prefix of it. Longest, because `/` prefixes
 * everything and a group's own page prefixes its siblings; whole-segment, so
 * `/financial/deposits` does not light up `/financial/deposit`.
 */
export function activeHref(
  hrefs: readonly string[],
  pathname: string,
): string | null {
  const path = trimSlash(pathname);
  let best: string | null = null;
  for (const raw of hrefs) {
    const href = trimSlash(raw);
    const matches =
      href === "/" || path === href || path.startsWith(`${href}/`);
    if (matches && (best === null || href.length > best.length)) best = href;
  }
  return best;
}
