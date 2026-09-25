import {
  BookOpen,
  CreditCard,
  Globe,
  HandCoins,
  Headphones,
  Home,
  Landmark,
  Package,
  Rocket,
  Server,
  ShieldCheck,
  ReceiptText,
  Settings,
  Store,
  ShoppingCart,
  TicketPercent,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { PANEL_CATALOG, PANEL_COUPONS, PANEL_DEPOSIT, PANEL_FINANCIAL, PANEL_GATEWAYS, PANEL_HOME, PANEL_MANUAL_PAYMENTS, PANEL_MY_SERVICES, PANEL_RESELLER_PURCHASE, PANEL_RESELLERS, PANEL_SETTINGS, PANEL_SHOP, PANEL_SYSTEMS, PANEL_TENANT_BILLING } from "@/lib/routes";
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
type PermissionGated = {
  requires?: readonly string[];
  /**
   * The tenant types the entry exists in, when not all of them (F-019-d). A
   * permission a role holds in every tenant can still name a surface only one
   * kind of tenant has — a reseller's billing wallet. Compared against
   * `me.tenant.type`; while that is unknown, such an entry is hidden.
   */
  tenantTypes?: readonly TenantType[];
  /**
   * The tenant's owner stands in for `requires` (F-019-f) — for an entry whose
   * service admits the owner without the permission, so the menu does not hide
   * a page the owner may open. `tenantTypes` still applies. Compared against
   * `me.tenant.isOwner`.
   */
  ownerSuffices?: boolean;
  /**
   * Callers the entry is not for even when everything above admits them
   * (F-114-c) — an invitation to someone who has already accepted it.
   * `tenantOwner` is `me.tenant.isOwner`; `resellerOwner` is a caller who
   * already owns a reseller, and while that is unknown the entry is hidden.
   */
  hiddenFrom?: readonly ("tenantOwner" | "resellerOwner")[];
};

export type TenantType = "platform_owner" | "reseller";

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
  { id: "buy", label: M.buy, icon: ShoppingCart, href: PANEL_SHOP },
  // F-502-s
  { id: "my-services", label: M.myServices, icon: Globe, href: PANEL_MY_SERVICES },
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
      // F-019-d. A reseller's own balance with the platform; the service admits
      // its owner too, who may hold no role that grants the permission (F-019-f).
      {
        id: "tenant-billing",
        label: M.tenantBilling,
        icon: HandCoins,
        href: PANEL_TENANT_BILLING,
        requires: ["tenant_billing.topup"],
        tenantTypes: ["reseller"],
        ownerSuffices: true,
      },
    ],
  },
  // F-018-k. Administration of other tenants is the platform owner's alone: a
  // reseller can grant itself `tenant.manage`, so the tenant type gates it too.
  {
    id: "resellers",
    label: M.resellers,
    icon: Store,
    href: PANEL_RESELLERS,
    requires: ["tenant.manage"],
    tenantTypes: ["platform_owner"],
  },
  // F-019-i. The other side of the same product: any user of the platform
  // owner's tenant may buy a reseller, so this one names no permission key —
  // only the tenant type, which is the service's own `not_platform_user`.
  // F-114-c: not the platform's own account, and not a user who already owns
  // one — the sidebar's "my reseller panel" is their way in.
  {
    id: "buy-reseller",
    label: M.buyReseller,
    icon: Rocket,
    href: PANEL_RESELLER_PURCHASE,
    tenantTypes: ["platform_owner"],
    hiddenFrom: ["tenantOwner", "resellerOwner"],
  },
  // F-027-ad. The platform's own panels. billing refuses anyone but the
  // platform owner (`panelScopeOf`), so the tenant type gates it here too.
  {
    id: "systems",
    label: M.systems,
    icon: Server,
    href: PANEL_SYSTEMS,
    requires: ["panel.manage"],
    tenantTypes: ["platform_owner"],
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
 *
 * `tenantType` is `me.tenant.type`. It may be left out, and then every entry
 * that names `tenantTypes` is hidden — the safe direction, as for `held`. `*`
 * does not stand in for it: a SuperAdmin of the platform owner has no reseller
 * wallet either.
 *
 * `isOwner` is `me.tenant.isOwner`, and counts only on an entry marked
 * `ownerSuffices`. Absent means not the owner — the safe direction again.
 *
 * `ownsReseller` is whether the caller owns a reseller (`GET /auth/handoff`),
 * read only by an entry `hiddenFrom` `resellerOwner`; `null` is not yet known,
 * and hides it.
 */
export function visibleMenu(
  entries: readonly PanelMenuEntry[],
  held: readonly string[],
  tenantType: TenantType | null = null,
  isOwner = false,
  ownsReseller: boolean | null = null,
): VisibleMenuEntry[] {
  const hidden = (e: PermissionGated) =>
    (e.hiddenFrom?.includes("tenantOwner") === true && isOwner) ||
    (e.hiddenFrom?.includes("resellerOwner") === true && ownsReseller !== false);
  const permitted = (e: PermissionGated) =>
    !hidden(e) &&
    (!e.tenantTypes || (tenantType !== null && e.tenantTypes.includes(tenantType))) &&
    ((isOwner && e.ownerSuffices === true) ||
      held.includes(ALL_PERMISSIONS) ||
      (e.requires ?? []).every((key) => held.includes(key)));
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
