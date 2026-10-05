import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { admits, type PermissionGated, type TenantType } from "./panel-menu";

const W = FrontendI18nKeys.common.dashboard.widgets;

/**
 * One dashboard widget (UX-1-p, `contract.ux.md` D1). It is gated exactly as a
 * menu entry is (`PermissionGated`, through the same `admits`), and a widget
 * that links to a page names it in `page` — a menu id — so it is drawn only
 * while that entry is in the caller's visible menu (D5: "by the permission of
 * the page it links to"), whatever extra door the menu applies there.
 */
export interface WidgetDef extends PermissionGated {
  id: string;
  /** A `common` namespace key. */
  titleKey: string;
  /** Columns it spans from `md` up; below `md` every widget is one column. */
  size: 1 | 2;
  page?: string;
  /** Loaded when first drawn, so a hidden widget costs nothing. */
  component: LazyExoticComponent<ComponentType>;
}

/**
 * Every widget, in D6's default order — the order of this array. A new widget
 * is added in its D6 place; a saved layout that does not know it yet puts it
 * there too (`dashboardLayout`).
 */
export const WIDGETS: readonly WidgetDef[] = [
  // D2 (F-0209): a switch must be visible, so "accounts in this browser" stays.
  { id: "accounts", titleKey: W.accounts, size: 1, component: lazy(() => import("../_components/dashboard/widgets/AccountsWidget")) },
];

export interface WidgetGate {
  held: readonly string[];
  tenantType: TenantType | null;
  isOwner: boolean;
  /** The ids of every entry in the caller's visible menu, groups' children included. */
  menuIds: ReadonlySet<string>;
}

/** The widgets this caller may see, in the registry's order. */
export function visibleWidgets(defs: readonly WidgetDef[], gate: WidgetGate): WidgetDef[] {
  return defs.filter(
    (w) => admits(w, gate.held, gate.tenantType, gate.isOwner, false) && (w.page === undefined || gate.menuIds.has(w.page)),
  );
}

export interface DashboardLayout {
  order: string[];
  hidden: string[];
}

/**
 * The saved `ui.dashboard` over the widgets `ids` (in default order) the caller
 * sees (D3): a saved id not among them is ignored; one of them the saved order
 * lacks goes in right after the nearest widget that precedes it by default, or
 * first when none does. Nothing saved is the default order.
 */
export function dashboardLayout(ids: readonly string[], saved: DashboardLayout): DashboardLayout {
  const known = new Set(ids);
  const order = saved.order.filter((id, i) => known.has(id) && saved.order.indexOf(id) === i);
  ids.forEach((id, i) => {
    if (order.includes(id)) return;
    const before = ids.slice(0, i).reverse().find((p) => order.includes(p));
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id);
  });
  return { order, hidden: saved.hidden.filter((id) => known.has(id)) };
}

/**
 * What Done writes (D3): the edited layout of what the caller sees, and every
 * registered widget they cannot see now kept as it was saved — a permission
 * lost for a day does not cost its place. An id the registry lost is dropped.
 */
export function layoutToSave(saved: DashboardLayout, registered: readonly string[], edited: DashboardLayout): DashboardLayout {
  const seen = new Set(edited.order);
  const kept = (ids: string[]) => ids.filter((id) => registered.includes(id) && !seen.has(id));
  return { order: [...edited.order, ...kept(saved.order)], hidden: [...edited.hidden, ...kept(saved.hidden)] };
}

export type TimeOfDay = "morning" | "afternoon" | "evening" | "night";

/** D2: the hour in `zone` (the caller's resolved zone; the browser's when unknown). */
export function timeOfDay(now: Date, zone: string | null): TimeOfDay {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", ...(zone ? { timeZone: zone } : {}) }).format(now),
  );
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}
