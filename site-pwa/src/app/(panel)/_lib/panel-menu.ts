import {
  BookOpen,
  CreditCard,
  Globe,
  Headphones,
  Home,
  ReceiptText,
  Settings,
  ShoppingCart,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { PANEL_DEPOSIT, PANEL_FINANCIAL, PANEL_HOME } from "@/lib/routes";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The shell's menu labels as generated constants (C-06). */
const M = FrontendI18nKeys.common.shell.menu;

export interface PanelMenuLink {
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

export interface PanelMenuGroup {
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
    ],
  },
  { id: "tutorials", label: M.tutorials, icon: BookOpen, href: null },
  { id: "support", label: M.support, icon: Headphones, href: null },
  { id: "settings", label: M.settings, icon: Settings, href: null },
];

export function isMenuGroup<T extends PanelMenuEntry | VisibleMenuEntry>(
  entry: T,
): entry is Extract<T, { children: unknown }> {
  return "children" in entry;
}

/** The menu as rendered: links with no page dropped, then groups left empty. */
export function visibleMenu(
  entries: readonly PanelMenuEntry[],
): VisibleMenuEntry[] {
  const hasPage = (l: PanelMenuLink): l is VisibleMenuLink => l.href !== null;
  const out: VisibleMenuEntry[] = [];
  for (const entry of entries) {
    if (isMenuGroup(entry)) {
      const children = entry.children.filter(hasPage);
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
