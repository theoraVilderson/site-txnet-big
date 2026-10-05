"use client";

import { useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { LangDropdown } from "@auth/auth/_components/LangDropdown";
import { BrandMark } from "@/components/BrandMark";
import { CollapsedTooltip } from "./CollapsedTooltip";
import { Popover } from "./kit/Popover";
import { useMediaQuery } from "./kit/overlay";
import { LogoutButton } from "./LogoutButton";
import { ResellerPanelButton, useOwnedResellers } from "./ResellerPanelButton";
import { ThemeDropdown } from "@auth/auth/_components/ThemeDropdown";
import { useLocale } from "@/context/LocaleContext";
import { resellerPurchaseApi, tenantAccessApi } from "@/lib/tenant-api";
import { holdsPermission } from "@/lib/permissions";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { DURATION, EASE } from "@/lib/motion";
import {
  PANEL_MENU,
  activeHref,
  badgeLabel,
  isMenuGroup,
  menuFooter,
  menuHrefs,
  menuSections,
  ownTenantOf,
  visibleMenu,
  type VisibleMenuEntry,
  type VisibleMenuGroup,
  type VisibleMenuLink,
} from "../_lib/panel-menu";
import { useMenuBadges, type BadgedEntry } from "../_hooks/useMenuBadges";
import { usePanelUiStore } from "../_stores/panel-ui-store";
import { toggleSidebarCollapsed, useUiPreferences } from "@/stores/ui-preferences-store";
import { usePanelSession } from "../_context/PanelSessionContext";

/** The shell's strings as generated constants (C-06). */
const S = FrontendI18nKeys.common.shell;

export const PANEL_SIDEBAR_ID = "panel-sidebar";

/** Where the sidebar is a rail that may collapse, rather than a drawer. */
const LG_UP = "(min-width: 1024px)";
/** How far a finger must drag the drawer toward its edge to close it (N3). */
const SWIPE_CLOSE_PX = 60;

/** A height fold — a section (N2) or a group (N3) opening and shutting. */
const FOLD = {
  initial: { height: 0, opacity: 0 },
  animate: { height: "auto", opacity: 1, transition: { duration: DURATION.base, ease: EASE.standard } },
  exit: { height: 0, opacity: 0, transition: { duration: DURATION.fast, ease: EASE.exit } },
} as const;

/**
 * Whether the caller holds a live reseller — `GET /purchase/mine`, the one the
 * purchase refuses as `already_reseller` (F-114-c). Not `useOwnedResellers`:
 * that list keeps a terminated reseller, whose owner may buy again. Asked only
 * of a caller the entry could be shown to (`canAsk`); `null` while `me` is
 * unknown or the answer is pending, which hides the entry. A failed read is
 * `false`: the page answers a holder itself (F-019-l). A caller not asked is
 * `false` without a state write, derived at render.
 */
function useHoldsLiveReseller(canAsk: boolean | null): boolean | null {
  const [holds, setHolds] = useState<boolean | null>(null);
  useEffect(() => {
    if (!canAsk) return;
    let live = true;
    resellerPurchaseApi
      .mine()
      .then((r) => live && setHolds(r.reseller !== null))
      .catch(() => live && setHolds(false));
    return () => {
      live = false;
    };
  }, [canAsk]);
  if (canAsk === null) return null;
  return canAsk ? holds : false;
}

/**
 * The door's `canRead` for the caller's own reseller tenant (F-311-ab,
 * `ownTenantOf`), asked only of `tenantId` when given; `null` until it answers
 * for that id. A failed read is `false`: the entry is a shortcut, and hiding it
 * never breaks the sidebar.
 */
function useCanAdminister(tenantId: string | null): boolean | null {
  const [answer, setAnswer] = useState<{ id: string; canRead: boolean } | null>(null);
  useEffect(() => {
    if (tenantId === null) return;
    let live = true;
    tenantAccessApi
      .get(tenantId)
      .then((r) => live && setAnswer({ id: tenantId, canRead: r.canRead }))
      .catch(() => live && setAnswer({ id: tenantId, canRead: false }));
    return () => {
      live = false;
    };
  }, [tenantId]);
  return answer !== null && answer.id === tenantId ? answer.canRead : null;
}

/**
 * The panel's sidebar (F-093-a, UX-1-j). One element, two behaviours: from
 * `lg` up it is pinned at the inline start and may collapse to icons; below
 * `lg` it is an off-canvas drawer the top bar opens, closed by its X, the
 * backdrop, Esc, or a swipe toward its edge. Every side is logical
 * (`start`/`end`), because the same panel runs RTL and LTR.
 *
 * The menu is drawn in N1's sections, each folding from its heading (N2);
 * headings appear only when more than one section is visible. The active
 * entry's highlight slides between entries (`layoutId`), a group opens with a
 * height animation, and while collapsed a group opens as a flyout beside the
 * rail (N3). Support, the support inbox and manual payments carry a count (N4).
 */
export function PanelSidebar() {
  const { t } = useLocale();
  const pathname = usePathname();
  // The collapse is the person's `ui.sidebar.collapsed` (UX-1-l); the rest is this tab's.
  const collapsed = useUiPreferences((s) => s.prefs["ui.sidebar"].collapsed);
  const { drawerOpen, openGroupId, closedSections } = usePanelUiStore(
    useShallow((s) => ({
      drawerOpen: s.drawerOpen,
      openGroupId: s.openGroupId,
      closedSections: s.closedSections,
    })),
  );
  const { setDrawerOpen, toggleGroup, openGroup, toggleSection, loadClosedSections } =
    usePanelUiStore(
      useShallow((s) => ({
        setDrawerOpen: s.setDrawerOpen,
        toggleGroup: s.toggleGroup,
        openGroup: s.openGroup,
        toggleSection: s.toggleSection,
        loadClosedSections: s.loadClosedSections,
      })),
    );
  const wide = useMediaQuery(LG_UP);
  // Collapsed applies from `lg` up only; the drawer always shows labels.
  const railCollapsed = collapsed && wide;
  // The flyout open, and the path it was opened on: a navigation closes it
  // without an effect, because on any other path it reads as closed.
  const [flyout, setFlyout] = useState<{ id: string; path: string } | null>(null);
  const flyoutId = flyout !== null && flyout.path === pathname ? flyout.id : null;

  // This device's folds, read after the first paint so the server render matches.
  useEffect(() => loadClosedSections(), [loadClosedSections]);

  // Authority comes off the caller, never off the path (F-097): until `me`
  // answers, nothing gated is shown.
  const { me } = usePanelSession();
  const held = me?.permissions;
  const tenantType = me?.tenant.type ?? null;
  const isOwner = me?.tenant.isOwner ?? false;
  const resellers = useOwnedResellers();
  const ownsReseller = useHoldsLiveReseller(me ? tenantType === "platform_owner" && !isOwner : null);
  // Asked only where it can change the answer: a reseller's user holding the key.
  const canAdminister = useCanAdminister(
    me && tenantType === "reseller" && holdsPermission(held, "tenant.manage") ? me.tenant.id : null,
  );
  const tenantId = ownTenantOf(me?.tenant ?? null, canAdminister);
  const menu = useMemo(
    () => visibleMenu(PANEL_MENU, held ?? [], tenantType, isOwner, ownsReseller, tenantId),
    [held, tenantType, isOwner, ownsReseller, tenantId],
  );
  const sections = useMemo(() => menuSections(menu), [menu]);
  const footer = useMemo(() => menuFooter(menu), [menu]);
  const headings = sections.length > 1;
  const active = activeHref(menuHrefs(menu), pathname);
  const badges = useMenuBadges();

  // A navigation closes the drawer, and opens the group the new page is in —
  // otherwise the highlighted entry sits inside a closed submenu.
  useEffect(() => {
    setDrawerOpen(false);
    const group = menu.find(
      (e): e is VisibleMenuGroup =>
        isMenuGroup(e) && e.children.some((c) => c.href === active),
    );
    if (group) openGroup(group.id);
  }, [pathname, active, menu, setDrawerOpen, openGroup]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, setDrawerOpen]);

  // Below `lg`, a horizontal drag toward the drawer's own edge closes it.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: TouchEvent) => {
    if (!drawerOpen || wide) return;
    swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: TouchEvent) => {
    const from = swipe.current;
    swipe.current = null;
    if (!from) return;
    const dx = e.changedTouches[0].clientX - from.x;
    const dy = e.changedTouches[0].clientY - from.y;
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const towardEdge = rtl ? dx : -dx;
    if (towardEdge > SWIPE_CLOSE_PX && Math.abs(dx) > Math.abs(dy)) setDrawerOpen(false);
  };

  const whenCollapsed = (classes: string) => (collapsed ? classes : "");

  const badgeOf = (id: string) => badgeLabel(badges[id as BadgedEntry] ?? null);

  const renderBadge = (text: string | null) =>
    text === null ? null : (
      <span
        aria-hidden
        className={`min-w-5 rounded-full bg-error px-1.5 text-center text-[11px] font-bold leading-5 text-on-error ${whenCollapsed(
          "lg:absolute lg:-top-0.5 lg:end-1 lg:min-w-4 lg:px-1 lg:text-[10px] lg:leading-4",
        )}`}
      >
        {text}
      </span>
    );

  const renderLink = (item: VisibleMenuLink, nested: boolean) => {
    const isActive = item.href === active;
    const Icon = item.icon;
    const label = t("common", item.label);
    const badge = badgeOf(item.id);
    return (
      <Link
        key={item.id}
        href={item.href}
        aria-current={isActive ? "page" : undefined}
        // With a count, the name says it as words in the reader's language; the
        // number drawn beside the label is decorative.
        aria-label={badge === null ? undefined : t("common", S.badge, { label, count: badge })}
        className={`group relative flex items-center gap-3 rounded-xl px-3 transition-colors duration-200 ${
          nested ? "py-2 text-sm" : "py-3"
        } ${
          isActive
            ? nested
              ? "font-bold text-primary"
              : "text-on-accent"
            : "text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
        }`}
      >
        {isActive && (
          <motion.span
            layoutId="panel-sidebar-active"
            aria-hidden
            transition={{ duration: DURATION.slow, ease: EASE.standard }}
            className={`absolute inset-0 -z-10 rounded-xl ${nested ? "bg-leaf-bg" : "bg-primary shadow-md shadow-primary-glow"}`}
          />
        )}
        <Icon size={nested ? 18 : 22} className="shrink-0" />
        <span className={`flex-1 truncate font-medium ${whenCollapsed("lg:sr-only")}`}>{label}</span>
        {renderBadge(badge)}
        {!nested && <CollapsedTooltip collapsed={collapsed} label={label} />}
      </Link>
    );
  };

  const renderGroup = (group: VisibleMenuGroup) => {
    const isOpen = openGroupId === group.id;
    const containsActive = group.children.some((c) => c.href === active);
    const Icon = group.icon;
    const submenuId = `${PANEL_SIDEBAR_ID}-${group.id}`;
    const label = t("common", group.label);
    const trigger = (
      <button
        type="button"
        aria-expanded={railCollapsed ? undefined : isOpen}
        aria-controls={railCollapsed ? undefined : submenuId}
        className={`group relative flex w-full items-center gap-3 rounded-xl px-3 py-3 text-start transition-colors duration-200 ${
          containsActive
            ? "text-primary"
            : "text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
        }`}
      >
        <Icon size={22} className="shrink-0" />
        <span className={`flex-1 truncate font-medium ${whenCollapsed("lg:sr-only")}`}>{label}</span>
        <ChevronDown
          size={16}
          className={`shrink-0 transition-transform duration-300 ${isOpen ? "rotate-180" : ""} ${whenCollapsed("lg:hidden")}`}
        />
        <CollapsedTooltip collapsed={collapsed && flyoutId !== group.id} label={label} />
      </button>
    );
    return (
      <div key={group.id} className="flex flex-col">
        {/* Collapsed, a group opens beside the rail (N3); otherwise the
            popover never opens and the click folds the submenu in place. */}
        <Popover
          label={label}
          side="end"
          open={flyoutId === group.id}
          onOpenChange={(next) => {
            if (next && !railCollapsed) return toggleGroup(group.id);
            setFlyout(next ? { id: group.id, path: pathname } : null);
          }}
          trigger={trigger}
          className="w-60 p-2"
        >
          <p className="px-3 pb-1 pt-1 text-xs font-bold text-text-secondary">{label}</p>
          <div className="space-y-1">{group.children.map((child) => renderLink(child, true))}</div>
        </Popover>
        <AnimatePresence initial={false}>
          {isOpen && !railCollapsed && (
            <motion.div key="submenu" id={submenuId} {...FOLD} className="overflow-hidden">
              <div className="ms-5 mt-1 space-y-1 border-s border-card-border ps-3">
                {group.children.map((child) => renderLink(child, true))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  const renderEntry = (entry: VisibleMenuEntry) =>
    isMenuGroup(entry) ? renderGroup(entry) : renderLink(entry, false);

  return (
    <>
      <aside
        id={PANEL_SIDEBAR_ID}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        className={`fixed inset-y-0 start-0 z-40 flex w-72 flex-col border-e border-card-border bg-card-bg backdrop-blur-xl transition-[width,translate] duration-300 ease-[cubic-bezier(0.25,0.8,0.25,1)] ${whenCollapsed("lg:w-20")} ${
          drawerOpen ? "" : "max-lg:ltr:-translate-x-full max-lg:rtl:translate-x-full"
        }`}
      >
        <div
          className={`flex h-20 shrink-0 items-center justify-between gap-2 border-b border-card-border px-5 ${whenCollapsed("lg:justify-center lg:px-0")}`}
        >
          <div className={`flex items-center gap-3 overflow-hidden ${whenCollapsed("lg:hidden")}`}>
            <BrandMark nameClassName="truncate text-xl font-bold tracking-tight text-text-primary" />
          </div>
          <button
            type="button"
            onClick={toggleSidebarCollapsed}
            aria-label={t("common", collapsed ? S.expand : S.collapse)}
            aria-controls={PANEL_SIDEBAR_ID}
            aria-expanded={!collapsed}
            className="hidden rounded-lg p-2 text-text-secondary transition-colors hover:bg-leaf-bg hover:text-text-primary lg:flex"
          >
            {collapsed ? (
              <PanelLeftOpen size={20} className="rtl:-scale-x-100" />
            ) : (
              <PanelLeftClose size={20} className="rtl:-scale-x-100" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label={t("common", S.closeMenu)}
            className="rounded-lg p-2 text-text-secondary transition-colors hover:text-text-primary lg:hidden"
          >
            <X size={22} />
          </button>
        </div>

        {/* The drawer holds these for as long as it exists — below `lg`, the
            same breakpoint that decides whether this is a drawer or a rail.
            They used to reappear in the top bar at `sm`, which put them back
            beside a menu button that is also only there below `lg`, and that
            combination is what broke the bar across the tablet band. */}
        <div className="flex items-center justify-between gap-2 border-b border-card-border px-5 py-3 lg:hidden">
          <span className="text-sm font-medium text-text-secondary">
            {t("common", S.preferences)}
          </span>
          <div className="flex items-center gap-2">
            <LangDropdown />
            <ThemeDropdown />
          </div>
        </div>

        <nav
          aria-label={t("common", S.navigation)}
          // A collapsed tooltip is drawn outside the rail, which a scroll
          // container would clip — so the rail does not scroll while collapsed.
          className={`isolate flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 ${whenCollapsed("lg:overflow-visible")}`}
        >
          {sections.map((section) => {
            const folded = headings && closedSections.includes(section.id);
            const listId = `${PANEL_SIDEBAR_ID}-section-${section.id}`;
            const list = <div className="space-y-1 pb-2">{section.entries.map(renderEntry)}</div>;
            if (!headings) return <div key={section.id}>{list}</div>;
            return (
              <div key={section.id} className="mt-2 first:mt-0">
                <button
                  type="button"
                  aria-expanded={!folded}
                  aria-controls={listId}
                  onClick={() => toggleSection(section.id)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-text-secondary transition-colors hover:text-text-primary ${whenCollapsed(
                    "lg:justify-center lg:px-0",
                  )}`}
                >
                  <span className={whenCollapsed("lg:sr-only")}>{t("common", section.label)}</span>
                  <ChevronDown
                    size={14}
                    aria-hidden
                    className={`transition-transform duration-200 ${folded ? "-rotate-90 rtl:rotate-90" : ""} ${whenCollapsed("lg:hidden")}`}
                  />
                  {collapsed && <span aria-hidden className="hidden h-px w-6 bg-card-border lg:block" />}
                </button>
                <AnimatePresence initial={false}>
                  {!folded && (
                    <motion.div key="list" id={listId} {...FOLD} className={`overflow-hidden ${whenCollapsed("lg:overflow-visible")}`}>
                      {list}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </nav>

        {/*
          Logout's one home, at every width (ADR-0035). It is a nav action, not
          a top-bar control: the switcher's own last row is *sign out of all
          devices*, and that comment is explicit that ordinary logout lives on
          the nav, far from it — the two are different intentions and the
          destructive one must not sit a mis-tap away from the everyday one.
          Keeping it here also takes the widest control out of a bar that was
          over budget at 360px **and** at 700px. Settings sits above it (N1).
        */}
        <div className="isolate shrink-0 space-y-1 border-t border-card-border px-3 py-4">
          {footer.map(renderEntry)}
          <ResellerPanelButton resellers={resellers} collapsed={collapsed} />
          <LogoutButton collapsed={collapsed} />
        </div>
      </aside>

      <AnimatePresence>
        {drawerOpen && (
          <motion.div
            key="backdrop"
            aria-hidden
            onClick={() => setDrawerOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: DURATION.base } }}
            exit={{ opacity: 0, transition: { duration: DURATION.fast } }}
            className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm lg:hidden"
          />
        )}
      </AnimatePresence>
    </>
  );
}
