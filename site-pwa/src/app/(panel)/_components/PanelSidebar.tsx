"use client";

import { useEffect, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { LangDropdown } from "@auth/auth/_components/LangDropdown";
import { CollapsedTooltip } from "./CollapsedTooltip";
import { LogoutButton } from "./LogoutButton";
import { ThemeDropdown } from "@auth/auth/_components/ThemeDropdown";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import {
  PANEL_MENU,
  activeHref,
  isMenuGroup,
  menuHrefs,
  visibleMenu,
  type VisibleMenuGroup,
  type VisibleMenuLink,
} from "../_lib/panel-menu";
import { usePanelUiStore } from "../_stores/panel-ui-store";
import { usePanelSession } from "../_context/PanelSessionContext";

/** The shell's strings as generated constants (C-06). */
const S = FrontendI18nKeys.common.shell;

export const PANEL_SIDEBAR_ID = "panel-sidebar";

/**
 * The panel's sidebar (F-093-a). One element, two behaviours: from `lg` up it
 * is pinned at the inline start and may collapse to icons; below `lg` it is an
 * off-canvas drawer the top bar opens. Every side is logical (`start`/`end`),
 * because the same panel runs RTL and LTR.
 */
export function PanelSidebar() {
  const { t } = useLocale();
  const pathname = usePathname();
  const { collapsed, drawerOpen, openGroupId } = usePanelUiStore(
    useShallow((s) => ({
      collapsed: s.collapsed,
      drawerOpen: s.drawerOpen,
      openGroupId: s.openGroupId,
    })),
  );
  const { toggleCollapsed, setCollapsed, setDrawerOpen, toggleGroup, openGroup } =
    usePanelUiStore(
      useShallow((s) => ({
        toggleCollapsed: s.toggleCollapsed,
        setCollapsed: s.setCollapsed,
        setDrawerOpen: s.setDrawerOpen,
        toggleGroup: s.toggleGroup,
        openGroup: s.openGroup,
      })),
    );

  // Authority comes off the caller, never off the path (F-097): until `me`
  // answers, nothing gated is shown.
  const { me } = usePanelSession();
  const held = me?.permissions;
  const menu = useMemo(() => visibleMenu(PANEL_MENU, held ?? []), [held]);
  const active = activeHref(menuHrefs(menu), pathname);

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

  // Collapsed applies from `lg` up only; the drawer always shows labels.
  const whenCollapsed = (classes: string) => (collapsed ? classes : "");

  const renderLink = (item: VisibleMenuLink, nested: boolean) => {
    const isActive = item.href === active;
    const Icon = item.icon;
    return (
      <Link
        key={item.id}
        href={item.href}
        aria-current={isActive ? "page" : undefined}
        className={`group relative flex items-center gap-3 rounded-xl px-3 transition-colors duration-200 ${
          nested ? "py-2 text-sm" : "py-3"
        } ${
          isActive
            ? nested
              ? "bg-leaf-bg font-bold text-primary"
              : "bg-primary text-white shadow-md shadow-primary-glow"
            : "text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
        }`}
      >
        <Icon size={nested ? 18 : 22} className="shrink-0" />
        <span
          className={`flex-1 truncate font-medium ${whenCollapsed("lg:sr-only")}`}
        >
          {t("common", item.label)}
        </span>
        {!nested && <CollapsedTooltip collapsed={collapsed} label={t("common", item.label)} />}
      </Link>
    );
  };

  const renderGroup = (group: VisibleMenuGroup) => {
    const isOpen = openGroupId === group.id;
    const containsActive = group.children.some((c) => c.href === active);
    const Icon = group.icon;
    const submenuId = `${PANEL_SIDEBAR_ID}-${group.id}`;
    return (
      <div key={group.id} className="flex flex-col">
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={submenuId}
          onClick={() => {
            // Collapsed, a submenu has nowhere to open: widen first, then open.
            if (collapsed && window.matchMedia("(min-width: 1024px)").matches) {
              setCollapsed(false);
              openGroup(group.id);
              return;
            }
            toggleGroup(group.id);
          }}
          className={`group relative flex w-full items-center gap-3 rounded-xl px-3 py-3 text-start transition-colors duration-200 ${
            containsActive
              ? "text-primary"
              : "text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
          }`}
        >
          <Icon size={22} className="shrink-0" />
          <span
            className={`flex-1 truncate font-medium ${whenCollapsed("lg:sr-only")}`}
          >
            {t("common", group.label)}
          </span>
          <ChevronDown
            size={16}
            className={`shrink-0 transition-transform duration-300 ${
              isOpen ? "rotate-180" : ""
            } ${whenCollapsed("lg:hidden")}`}
          />
          <CollapsedTooltip collapsed={collapsed} label={t("common", group.label)} />
        </button>
        {isOpen && (
          <div
            id={submenuId}
            className={`ms-5 mt-1 space-y-1 border-s border-card-border ps-3 ${whenCollapsed("lg:hidden")}`}
          >
            {group.children.map((child) => renderLink(child, true))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <aside
        id={PANEL_SIDEBAR_ID}
        className={`fixed inset-y-0 start-0 z-40 flex w-72 flex-col border-e border-card-border bg-card-bg backdrop-blur-xl transition-[width,translate] duration-300 ease-[cubic-bezier(0.25,0.8,0.25,1)] ${whenCollapsed("lg:w-20")} ${
          drawerOpen ? "" : "max-lg:ltr:-translate-x-full max-lg:rtl:translate-x-full"
        }`}
      >
        <div
          className={`flex h-20 shrink-0 items-center justify-between gap-2 border-b border-card-border px-5 ${whenCollapsed("lg:justify-center lg:px-0")}`}
        >
          <div className={`flex items-center gap-3 overflow-hidden ${whenCollapsed("lg:hidden")}`}>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-xl font-bold text-white shadow-lg shadow-primary-glow">
              T
            </div>
            <span className="truncate text-xl font-bold tracking-tight text-text-primary">
              TXNet
            </span>
          </div>
          <button
            type="button"
            onClick={toggleCollapsed}
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
          className={`flex-1 space-y-2 overflow-y-auto overflow-x-hidden px-3 py-6 ${whenCollapsed("lg:overflow-visible")}`}
        >
          {menu.map((entry) =>
            isMenuGroup(entry) ? renderGroup(entry) : renderLink(entry, false),
          )}
        </nav>

        {/*
          Logout's one home, at every width (ADR-0035). It is a nav action, not
          a top-bar control: the switcher's own last row is *sign out of all
          devices*, and that comment is explicit that ordinary logout lives on
          the nav, far from it — the two are different intentions and the
          destructive one must not sit a mis-tap away from the everyday one.
          Keeping it here also takes the widest control out of a bar that was
          over budget at 360px **and** at 700px.
        */}
        <div className="shrink-0 border-t border-card-border px-3 py-4">
          <LogoutButton collapsed={collapsed} />
        </div>
      </aside>

      {drawerOpen && (
        <div
          aria-hidden
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm lg:hidden"
        />
      )}
    </>
  );
}
