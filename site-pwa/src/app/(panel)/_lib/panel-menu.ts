import {
  BookMarked,
  BookOpen,
  Dices,
  Gift,
  CreditCard,
  Globe,
  HandCoins,
  Headphones,
  Home,
  Inbox,
  Landmark,
  List,
  Gauge,
  Boxes,
  Package,
  Rocket,
  Server,
  ShieldCheck,
  ReceiptText,
  Settings,
  SlidersHorizontal,
  Store,
  ShoppingCart,
  Sparkles,
  Ticket,
  TicketPercent,
  UserCog,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { PANEL_AI, PANEL_CATALOG, PANEL_COUPONS, PANEL_DEPOSIT, PANEL_FINANCIAL, PANEL_GATEWAYS, PANEL_GUIDES, PANEL_HOME, PANEL_LOTTERIES, PANEL_LOTTERIES_MANAGE, PANEL_MANUAL_PAYMENTS, PANEL_MY_SERVICES, PANEL_RESELLER_LIMITS, PANEL_RESELLER_PACKAGES, PANEL_RESELLER_PURCHASE, PANEL_RESELLERS, PANEL_SETTINGS, PANEL_SHOP, PANEL_SUPPORT, PANEL_SUPPORT_INBOX, PANEL_SUPPORT_SETTINGS, PANEL_SYSTEMS, PANEL_TENANT_BILLING, PANEL_GROUPS, PANEL_WHEEL, PANEL_WHEEL_SETTINGS, PANEL_USERS, panelSectionPath } from "@/lib/routes";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { holdsEveryPermission } from "@/lib/permissions";

/** The shell's menu labels as generated constants (C-06). */
const M = FrontendI18nKeys.common.shell.menu;
const SECTION = FrontendI18nKeys.common.shell.sections;

/** N1's six sections, in its order (UX-1-j, `contract.ux.md` N1). */
export const MENU_SECTIONS = [
  { id: "account", label: SECTION.account },
  { id: "sales", label: SECTION.sales },
  { id: "finance", label: SECTION.finance },
  { id: "people", label: SECTION.people },
  { id: "infra", label: SECTION.infra },
  { id: "support", label: SECTION.support },
] as const;

export type MenuSectionId = (typeof MENU_SECTIONS)[number]["id"];
/** `footer`: drawn above logout, under no heading — settings (N1). */
export type MenuPlacement = MenuSectionId | "footer";

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
export type PermissionGated = {
  requires?: readonly string[];
  /**
   * What a caller signed in to a **reseller** needs instead of `requires`
   * (AC-1-e2): the page's own reseller key (`RESELLER_KEYS`), where `requires`
   * is the platform's key for the same page — a seat's users are `user.read`,
   * the platform staff's `platform.tenant.manage`. Absent, `requires` serves both.
   */
  resellerRequires?: readonly string[];
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
   * already holds a live reseller, and while that is unknown the entry is hidden.
   */
  hiddenFrom?: readonly ("tenantOwner" | "resellerOwner")[];
};

export type TenantType = "platform_owner" | "reseller";

export interface PanelMenuLink extends PermissionGated {
  id: string;
  /** A `common` namespace key. */
  label: string;
  icon: LucideIcon;
  /**
   * `null` while the page does not exist. The entry is then hidden rather than
   * rendered as a dead link; the row that builds the page sets this to its
   * route constant, and `panel-menu.test.ts` checks the page is really there.
   * A page inside the caller's own tenant is a function of `me.tenant.id`
   * (F-311-ab), and is hidden while that id is unknown.
   */
  href: string | ((tenantId: string, self: boolean) => string) | null;
}

export interface PanelMenuGroup extends PermissionGated {
  id: string;
  label: string;
  icon: LucideIcon;
  children: PanelMenuLink[];
}

/**
 * The section a top-level entry is drawn in; a group's children are in its.
 * Absent reads as `account` — `sidebar.test.tsx` pins every entry of
 * `PANEL_MENU` to the section N1 names, so a forgotten one goes red there.
 */
type Placed = { section?: MenuPlacement };

export type PanelMenuEntry = (PanelMenuLink | PanelMenuGroup) & Placed;

/** `tag`: whose the link is when not the account's — a reseller's slug (UX-2-a2). */
export type VisibleMenuLink = Omit<PanelMenuLink, "href"> & {
  href: string;
  tag?: string;
  /**
   * A reseller's page (UX-2-a): drawn under the "reseller" button by this
   * short label; `label` stays the full one wherever the button is not
   * around it — pins, the palette, the breadcrumb.
   */
  short?: string;
  /** Steps done of all of them, drawn beside the label — the reseller's setup row (UX-2-e). */
  progress?: { done: number; total: number };
};
export type VisibleMenuGroup = Omit<PanelMenuGroup, "children"> & {
  children: VisibleMenuLink[];
  /** Whose, beside the label — the reseller button's slug (UX-2-a2). */
  tag?: string;
  /** Steps done of all of them — the reseller button while setup is incomplete (UX-2-e). */
  progress?: { done: number; total: number };
};
export type VisibleMenuEntry = (VisibleMenuLink | VisibleMenuGroup) & Placed;

/**
 * Every entry of the panel's menu, in N1's sections and order (UX-1-j). Each
 * top-level entry names its `section`; the sidebar draws them under one
 * heading per section (`menuSections`). An entry with no page yet is hidden —
 * see `href`.
 */
export const PANEL_MENU: readonly PanelMenuEntry[] = [
  // ── account ──
  { section: "account", id: "dashboard", label: M.dashboard, icon: Home, href: PANEL_HOME },
  { section: "account", id: "buy", label: M.buy, icon: ShoppingCart, href: PANEL_SHOP },
  // F-502-s
  { section: "account", id: "my-services", label: M.myServices, icon: Globe, href: PANEL_MY_SERVICES },
  {
    section: "account",
    id: "wallet",
    label: M.wallet,
    icon: Wallet,
    children: [
      // F-093-d
      { id: "financial-history", label: M.financialHistory, icon: ReceiptText, href: PANEL_FINANCIAL },
      // F-093-e
      { id: "deposit", label: M.deposit, icon: CreditCard, href: PANEL_DEPOSIT },
    ],
  },
  // F-707-g. Every signed-in user: billing's `GET /wheel` says whether a wheel
  // runs today and why this user may not spin it.
  { section: "account", id: "wheel", label: M.wheel, icon: Gift, href: PANEL_WHEEL },
  // F-707-n. Every signed-in user: billing shows each user only the lotteries of its groups.
  { section: "account", id: "lotteries", label: M.lotteries, icon: Ticket, href: PANEL_LOTTERIES },
  // F-033-o. Every signed-in user: support answers each with their own threads only.
  { section: "account", id: "support", label: M.support, icon: Headphones, href: PANEL_SUPPORT },
  // F-019-i. The other side of the reseller product: any user of the platform
  // owner's tenant may buy a reseller, so this one names no permission key —
  // only the tenant type, which is the service's own `not_platform_user`.
  // F-114-c: not the platform's own account, and not a user who already owns
  // one — the sidebar's "my reseller panel" is their way in.
  {
    section: "account",
    id: "buy-reseller",
    label: M.buyReseller,
    icon: Rocket,
    href: PANEL_RESELLER_PURCHASE,
    tenantTypes: ["platform_owner"],
    hiddenFrom: ["tenantOwner", "resellerOwner"],
  },
  { section: "account", id: "tutorials", label: M.tutorials, icon: BookOpen, href: null },

  // ── sales ──
  // F-026-f. The permission hides it, billing scopes what it lists (D-34).
  { section: "sales", id: "catalog", label: M.catalog, icon: Package, href: PANEL_CATALOG, requires: ["catalog.manage"] },
  // F-502-g. The permission hides it, billing scopes what it lists (D-33).
  { section: "sales", id: "coupons", label: M.coupons, icon: TicketPercent, href: PANEL_COUPONS, requires: ["coupon.manage"] },
  // F-038-j2. Every tenant has its own AI: the permission hides it, and ai
  // answers each tenant its own (F-038-j1).
  { section: "sales", id: "ai", label: M.ai, icon: Sparkles, href: PANEL_AI, requires: ["ai.manage"] },
  // F-707-f. Every tenant runs its own wheel: the permission hides it, RLS
  // answers each tenant its own (F-707-c).
  { section: "sales", id: "wheel-settings", label: M.wheelSettings, icon: Dices, href: PANEL_WHEEL_SETTINGS, requires: ["engagement.manage"] },
  // F-707-o. The same permission as the wheel's settings; RLS keeps each tenant to its own lotteries.
  { section: "sales", id: "lottery-settings", label: M.lotterySettings, icon: Ticket, href: PANEL_LOTTERIES_MANAGE, requires: ["engagement.manage"] },

  // ── finance ──
  // F-102-d. The permission hides it; what the page then shows is decided
  // by the tenant type, server-side (D-31).
  { section: "finance", id: "gateways", label: M.gateways, icon: Landmark, href: PANEL_GATEWAYS, requires: ["gateway.manage"] },
  // F-093-n. Like gateways: the permission hides it, billing scopes what it lists.
  { section: "finance", id: "manual-payments", label: M.manualPayments, icon: ShieldCheck, href: PANEL_MANUAL_PAYMENTS, requires: ["payment.confirm_manual"] },
  // F-019-d. A reseller's own balance with the platform; the service admits
  // its owner too, who may hold no role that grants the permission (F-019-f).
  {
    section: "finance",
    id: "tenant-billing",
    label: M.tenantBilling,
    icon: HandCoins,
    href: PANEL_TENANT_BILLING,
    requires: ["tenant_billing.topup"],
    tenantTypes: ["reseller"],
    ownerSuffices: true,
  },

  // ── people ──
  // F-311-ab. One users page for every tenant (D-55), opened on the tenant the
  // session is in: platform staff reach the platform's own users (F-311-aa), a
  // reseller's staff on its domain the reseller's — at `/users`, which ignores
  // the id but keeps the function so the tenant-id gate applies. The key hides it: the page's own,
  // `user.read`, on every tenant (AC-1-e2; the platform's since GR-1-o, ADR-0139 (7));
  // `ResellerAccess.…IncludingPlatform` is the door, and a seat it refuses reads
  // as that page's refusal. The owner signs in to the platform (ADR-0059), so
  // their reseller's users stay behind its console.
  { section: "people", id: "users", label: M.users, icon: UserCog, href: () => PANEL_USERS, requires: ["user.read"] },
  // F-114-m, GR-1-f. Every tenant has its own groups: the permission hides it,
  // and auth-service answers each tenant its own (F-114-j). The one place the
  // panel gives access (ADR-0139 (1)): Team and Roles left the menu for it.
  { section: "people", id: "groups", label: M.groups, icon: Users, href: PANEL_GROUPS, requires: ["user_group.manage"] },
  // F-018-k. Administration of other tenants is the platform owner's alone: a
  // platform key counts only on the platform's tenant (ADR-0135), so the tenant type gates it too.
  // Packages (F-118-n5) and limits (F-019-r) sit under the same gate.
  {
    section: "people",
    id: "resellers",
    label: M.resellers,
    icon: Store,
    requires: ["platform.tenant.manage"],
    tenantTypes: ["platform_owner"],
    children: [
      { id: "reseller-list", label: M.resellerList, icon: List, href: PANEL_RESELLERS },
      { id: "reseller-packages", label: M.resellerPackages, icon: Boxes, href: PANEL_RESELLER_PACKAGES },
      { id: "reseller-limits", label: M.resellerLimits, icon: Gauge, href: PANEL_RESELLER_LIMITS },
    ],
  },

  // ── infra ──
  // F-027-ad. The platform's own panels. billing refuses anyone but the
  // platform owner (`panelScopeOf`), so the tenant type gates it here too.
  { section: "infra", id: "systems", label: M.systems, icon: Server, href: PANEL_SYSTEMS, requires: ["platform.node.manage"], tenantTypes: ["platform_owner"] },

  // ── support ──
  // F-033-p. RLS keeps an agent to its own tenant's threads; the permission hides the page.
  { section: "support", id: "support-inbox", label: M.supportInbox, icon: Inbox, href: PANEL_SUPPORT_INBOX, requires: ["support.agent"] },
  { section: "support", id: "support-settings", label: M.supportSettings, icon: SlidersHorizontal, href: PANEL_SUPPORT_SETTINGS, requires: ["support.manage"] },
  // F-414-d. tenant-service decides whose guides: the platform's for its own admin, else the tenant's.
  { section: "support", id: "guides", label: M.guides, icon: BookMarked, href: PANEL_GUIDES, requires: ["guide.manage"] },

  { section: "footer", id: "settings", label: M.settings, icon: Settings, href: PANEL_SETTINGS },
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
 * `ownsReseller` is whether the caller holds a live reseller (`GET /purchase/mine`),
 * read only by an entry `hiddenFrom` `resellerOwner`; `null` is not yet known,
 * and hides it.
 *
 * `tenantId` is `me.tenant.id`, which builds an `href` that is a function of it
 * (F-311-ab); `null` hides such an entry. A reseller's session gets the
 * id-less address of its own domain (F-061-n).
 */
export function visibleMenu(
  entries: readonly PanelMenuEntry[],
  held: readonly string[],
  tenantType: TenantType | null = null,
  isOwner = false,
  ownsReseller: boolean | null = null,
  tenantId: string | null = null,
): VisibleMenuEntry[] {
  const permitted = (e: PermissionGated) => admits(e, held, tenantType, isOwner, ownsReseller);
  const withPage = (l: PanelMenuLink): VisibleMenuLink | null => {
    // `self`: a reseller's session, on its own domain — the id-less address (F-061-n).
    if (typeof l.href === "function")
      return tenantId === null ? null : { ...l, href: l.href(tenantId, tenantType === "reseller") };
    return l.href === null ? null : { ...l, href: l.href };
  };
  const out: VisibleMenuEntry[] = [];
  for (const entry of entries) {
    if (!permitted(entry)) continue;
    if (isMenuGroup(entry)) {
      const children = entry.children
        .filter(permitted)
        .map(withPage)
        .filter((c): c is VisibleMenuLink => c !== null);
      if (children.length > 0) out.push({ ...entry, children });
    } else {
      const link = withPage(entry);
      if (link) out.push(link);
    }
  }
  return out;
}

/**
 * Whether one gated thing is for this caller — `visibleMenu`'s rule for an
 * entry, and the dashboard's for a widget (UX-1-p, D1), so the two never
 * disagree about who may see what. The arguments are `visibleMenu`'s.
 */
export function admits(
  e: PermissionGated,
  held: readonly string[],
  tenantType: TenantType | null,
  isOwner = false,
  ownsReseller: boolean | null = null,
): boolean {
  const hidden =
    (e.hiddenFrom?.includes("tenantOwner") === true && isOwner) ||
    (e.hiddenFrom?.includes("resellerOwner") === true && ownsReseller !== false);
  return (
    !hidden &&
    (!e.tenantTypes || (tenantType !== null && e.tenantTypes.includes(tenantType))) &&
    ((isOwner && e.ownerSuffices === true) ||
      holdsEveryPermission(held, (tenantType === "reseller" ? e.resellerRequires : undefined) ?? e.requires ?? []))
  );
}

/**
 * The tenant id `visibleMenu` builds the caller's own pages on (F-311-ab), or
 * `null` to hide them. On the platform, the page's key (`user.read`, or `*`) is the whole of
 * the users-admin door's rule for its own people, and `requires` already holds it. On
 * a reseller it is not: the door also needs a live seat (invariant 21), which a
 * role outlives — so `canRead` is the door's own verdict (`GET /tenants/:id/access`),
 * and until it answers the pages stay hidden.
 */
export function ownTenantOf(
  tenant: { id: string; type: TenantType } | null,
  canRead: boolean | null,
): string | null {
  if (!tenant) return null;
  if (tenant.type === "platform_owner") return tenant.id;
  return canRead === true ? tenant.id : null;
}

/** Every href a visible menu links to, groups flattened. */
export function menuHrefs(entries: readonly VisibleMenuEntry[]): string[] {
  return entries.flatMap((e) =>
    isMenuGroup(e) ? e.children.map((c) => c.href) : [e.href],
  );
}

export interface VisibleMenuSection {
  id: MenuSectionId;
  /** A `common` namespace key. */
  label: string;
  entries: VisibleMenuEntry[];
}

/**
 * The visible menu under N1's headings, in N1's order (N2): a section with
 * nothing visible is left out, and the footer's entries are `menuFooter`'s.
 * The sidebar draws headings only when more than one section is left — a
 * caller who sees only `account` sees none.
 */
export function menuSections(entries: readonly VisibleMenuEntry[]): VisibleMenuSection[] {
  return MENU_SECTIONS.map((s) => ({
    id: s.id,
    label: s.label,
    entries: entries.filter((e) => (e.section ?? "account") === s.id),
  })).filter((s) => s.entries.length > 0);
}

/** The entries drawn in the sidebar's footer, above logout (N1: settings). */
export function menuFooter(entries: readonly VisibleMenuEntry[]): VisibleMenuEntry[] {
  return entries.filter((e) => e.section === "footer");
}

/** A menu badge's text (N4): nothing at zero or unknown, the count to 9, then `9+`. */
export function badgeLabel(count: number | null): string | null {
  if (count === null || count <= 0) return null;
  return count > 9 ? "9+" : String(count);
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

export interface MenuCrumb {
  /** A `common` namespace key. */
  label: string;
  /** A section's page, a group's heading on it; `null` only outside every section. */
  href: string | null;
  /** A section's heading (UX-1-j) — drawn only beside a trail that is drawn anyway. */
  section?: true;
}

/**
 * The breadcrumb trail for `pathname` (UX-1-i, `contract.ux.md` K14): the menu
 * tree from the top down to the entry `activeHref` would light up — its
 * section (UX-1-j; none for the footer), a group, then its page. Empty on a path no entry owns. It reads the whole menu, not
 * the caller's visible one: whoever is on the page may see where it sits.
 *
 * An `href` that is a function of a tenant id is matched with any one segment
 * in the id's place, and the crumb links to the segment the path holds — the
 * tenant the page is already on, so no session is needed to draw it.
 */
export function menuTrail(entries: readonly PanelMenuEntry[], pathname: string): MenuCrumb[] {
  const hrefOf = (l: PanelMenuLink) => {
    if (typeof l.href !== "function") return l.href;
    // A reseller's own domain addresses it with no id at all (F-061-n).
    const self = l.href("TENANTPROBE", true);
    if (!self.includes("TENANTPROBE") && (pathname === self || pathname.startsWith(`${self}/`))) return self;
    // An address with no id at all (`/users`): it is the path or it is not.
    if (!l.href("TENANTPROBE", false).includes("TENANTPROBE")) return null;
    // Letters only, so a path builder that encodes its id hands the probe back unchanged.
    const [before, after] = l.href("TENANTPROBE", false).split("TENANTPROBE");
    const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return pathname.match(new RegExp(`^${escape(before)}[^/]+${escape(after)}(?=/|$)`))?.[0] ?? null;
  };
  const trails: { href: string; trail: MenuCrumb[] }[] = [];
  for (const entry of entries) {
    const placed = entry.section ?? "account";
    const section = MENU_SECTIONS.find((s) => s.id === placed);
    const top: MenuCrumb[] = section ? [{ label: section.label, href: panelSectionPath(section.id), section: true }] : [];
    if (isMenuGroup(entry)) {
      for (const child of entry.children) {
        const href = hrefOf(child);
        if (href) trails.push({ href, trail: [...top, { label: entry.label, href: section ? panelSectionPath(section.id, entry.id) : null }, { label: child.label, href }] });
      }
    } else {
      const href = hrefOf(entry);
      if (href) trails.push({ href, trail: [...top, { label: entry.label, href }] });
    }
  }
  const active = activeHref(
    trails.map((t) => t.href),
    pathname,
  );
  if (active === null) return [];
  // `/` is the dashboard's own href and prefixes every path: only the dashboard itself is in it.
  if (active === "/" && trimSlash(pathname) !== "/") return [];
  return trails.find((t) => trimSlash(t.href) === active)?.trail ?? [];
}

/**
 * The menu while an admin is signed in as someone (AC-1-i): the account
 * section and the footer's settings alone. Every other section is a staff or
 * reseller route, which an impersonated token never reaches (ADR-0136),
 * whatever the person holds.
 */
export function impersonationMenu<T extends { section?: string }>(entries: readonly T[]): T[] {
  return entries.filter((e) => e.section === undefined || e.section === "account" || e.section === "footer");
}
