"use client";

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import {
  CornerDownLeft,
  CreditCard,
  Gift,
  Headphones,
  History,
  Languages,
  Palette,
  Pin,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "@/context/LocaleContext";
import { useTheme } from "@/context/ThemeContext";
import { AVAILABLE_THEMES, type ThemeName } from "@/env";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE, type MotionPreference } from "@/lib/motion";
import { PANEL_DEPOSIT, PANEL_SUPPORT, PANEL_SUPPORT_NEW, panelSettingsTabPath } from "@/lib/routes";
import { useUiPreferences } from "@/stores/ui-preferences-store";
import { usePanelSession } from "../_context/PanelSessionContext";
import { usePaletteData } from "../_hooks/usePaletteData";
import { useVisibleMenu } from "../_hooks/useVisibleMenu";
import { isMenuGroup, type VisibleMenuLink } from "../_lib/panel-menu";
import { PALETTE_GROUPS, paletteResults, type PaletteGroup, type PaletteItem } from "../_lib/palette";
import { togglePin } from "../_lib/pins";
import { readRecentPages } from "../_lib/recent-pages";
import { usePanelUiStore } from "../_stores/panel-ui-store";
import { settingsTabs } from "../settings/_lib/settings";
import { cn } from "./kit/cn";
import { useOverlayLayer } from "./kit/overlay";

const P = FrontendI18nKeys.common.shell.palette;
const A = FrontendI18nKeys.common.settings.appearance;

const GROUP_LABEL: Record<PaletteGroup, string> = {
  recent: P.groups.recent,
  pages: P.groups.pages,
  services: P.groups.services,
  tickets: P.groups.tickets,
  users: P.groups.users,
  settings: P.groups.settings,
  actions: P.groups.actions,
};

type ThemeChoice = ThemeName | "system";
const MOTION: readonly MotionPreference[] = ["system", "full", "reduced"];

/** Ctrl/⌘+K by the key's place, so a Persian layout (which sends "ن") opens it too. */
const isPaletteKey = (e: globalThis.KeyboardEvent) =>
  (e.ctrlKey || e.metaKey) && !e.altKey && (e.code === "KeyK" || e.key.toLowerCase() === "k");

/**
 * The command palette (UX-1-n, `contract.ux.md` N6): mounted once by the shell,
 * opened by Ctrl/⌘+K anywhere in the panel, the top bar's `PaletteButton` and
 * not-found's. Its body — and the menu reads it needs — exists only while open.
 */
export function CommandPalette() {
  const open = usePanelUiStore((s) => s.paletteOpen);
  const setOpen = usePanelUiStore((s) => s.setPaletteOpen);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isPaletteKey(e)) return;
      e.preventDefault();
      setOpen(!usePanelUiStore.getState().paletteOpen);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  return <AnimatePresence>{open && <PaletteLayer key="palette" onClose={() => setOpen(false)} />}</AnimatePresence>;
}

/** The top bar's way in: a search box look from `sm`, an icon below it (N6). */
export function PaletteButton({ className }: { className?: string }) {
  const { t } = useLocale();
  const setOpen = usePanelUiStore((s) => s.setPaletteOpen);
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={t("common", P.openHint)}
      aria-keyshortcuts="Control+K Meta+K"
      className={cn(
        "flex items-center gap-2 rounded-xl p-2 text-text-secondary transition-colors hover:bg-leaf-bg hover:text-text-primary sm:min-w-44 sm:border sm:border-card-border sm:bg-bg-inner sm:px-3",
        className,
      )}
    >
      <Search size={18} aria-hidden className="shrink-0" />
      <span className="hidden flex-1 text-start text-sm sm:inline">{t("common", P.open)}</span>
      <kbd dir="ltr" className="hidden rounded-md border border-card-border px-1.5 text-[11px] font-medium sm:inline">
        Ctrl K
      </kbd>
    </button>
  );
}

function PaletteLayer({ onClose }: { onClose: () => void }) {
  const { t, tIn, lang, availableLocales, setLang } = useLocale();
  const { choice, setTheme } = useTheme();
  const { me } = usePanelSession();
  const router = useRouter();
  const level = useMotionLevel();
  const present = useIsPresent();
  const menu = useVisibleMenu();
  const pins = useUiPreferences((s) => s.prefs["ui.pins"]);
  const motionPref = useUiPreferences((s) => s.prefs["ui.motion"]);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Read once per opening: the visit that opened it is already in it.
  const [recent] = useState(readRecentPages);
  useOverlayLayer({ active: present, containerRef: panelRef, onClose, initialFocusRef: inputRef });

  /** A label in the current language and in English — both are searched (N6). */
  const both = (key: string, vars?: Record<string, string>, enVars?: Record<string, string>) => [
    t("common", key, vars),
    tIn("en", "common", key, enVars ?? vars),
  ];

  const items = useMemo<PaletteItem[]>(() => {
    const links = menu.flatMap((e): { link: VisibleMenuLink; group?: string }[] =>
      isMenuGroup(e) ? e.children.map((link) => ({ link, group: e.label })) : [{ link: e }],
    );
    const byId = new Map(links.map((l) => [l.link.id, l]));
    const page = (entry: { link: VisibleMenuLink; group?: string }, group: PaletteGroup, href = entry.link.href): PaletteItem => ({
      key: `${group}:${href}`,
      group,
      label: t("common", entry.link.label),
      hint: entry.group ? t("common", entry.group) : undefined,
      icon: entry.link.icon,
      haystacks: [...both(entry.link.label), ...(entry.group ? both(entry.group) : [])],
      href,
      pinId: entry.link.id,
    });

    const out: PaletteItem[] = [];
    for (const r of recent) {
      const entry = byId.get(r.id);
      if (entry) out.push({ ...page(entry, "recent", r.href), icon: History });
    }
    for (const entry of links) out.push(page(entry, "pages"));

    for (const tab of settingsTabs(me)) {
      const name = { tab: t("common", tab.label) };
      out.push({
        key: `settings:${tab.value}`,
        group: "settings",
        label: t("common", P.settingsTab, name),
        icon: Settings,
        haystacks: both(P.settingsTab, name, { tab: tIn("en", "common", tab.label) }),
        href: panelSettingsTabPath(tab.value),
      });
    }

    const action = (key: string, label: string, icon: PaletteItem["icon"], to: Pick<PaletteItem, "href" | "run">, vars?: Record<string, string>, enVars?: Record<string, string>) =>
      out.push({ key: `actions:${key}`, group: "actions", label: t("common", label, vars), icon, haystacks: both(label, vars, enVars), ...to });
    const hrefs = new Set(links.map((l) => l.link.href));
    if (hrefs.has(PANEL_DEPOSIT)) action("top-up", P.actions.topUp, CreditCard, { href: PANEL_DEPOSIT });
    if (hrefs.has(PANEL_SUPPORT)) action("new-ticket", P.actions.newTicket, Headphones, { href: PANEL_SUPPORT_NEW });
    action("gift-code", P.actions.giftCode, Gift, { run: () => usePanelUiStore.getState().setGiftCodeOpen(true) });
    for (const theme of ["system", ...AVAILABLE_THEMES] as ThemeChoice[]) {
      if (theme === choice) continue;
      action(`theme-${theme}`, P.actions.theme, Palette, { run: () => setTheme(theme) }, { name: t("common", A.themes[theme]) }, { name: tIn("en", "common", A.themes[theme]) });
    }
    for (const locale of availableLocales) {
      if (locale.code === lang) continue;
      action(`lang-${locale.code}`, P.actions.language, Languages, { run: () => void setLang(locale.code) }, { name: locale.name });
    }
    for (const m of MOTION) {
      if (m === motionPref) continue;
      action(`motion-${m}`, P.actions.motion, Sparkles, { run: () => useUiPreferences.getState().update({ "ui.motion": m }) }, { name: t("common", A.motion[m]) }, { name: tIn("en", "common", A.motion[m]) });
    }
    return out;
    // `both` and `t` change with `lang`, which is in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, recent, me, lang, choice, motionPref, availableLocales]);

  // Services, tickets and users, from their own sources (UX-1-o, N7).
  const data = usePaletteData(query, me, menu, t);
  const results = useMemo(() => paletteResults([...items, ...data.items], query), [items, data.items, query]);
  const current = results[Math.min(active, results.length - 1)] ?? null;
  const optionId = (item: PaletteItem) => `${id}-${item.key}`;

  useEffect(() => {
    if (!current) return;
    document.getElementById(optionId(current))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const runItem = (item: PaletteItem) => {
    onClose();
    if (item.href) router.push(item.href);
    else item.run?.();
  };
  const pin = (item: PaletteItem) => {
    if (!item.pinId) return;
    const update = useUiPreferences.getState().update;
    update({ "ui.pins": togglePin(useUiPreferences.getState().prefs["ui.pins"], item.pinId) });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const last = results.length - 1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (last < 0) return;
      const at = Math.min(active, last);
      setActive(e.key === "ArrowDown" ? (at + 1) % (last + 1) : (at - 1 + last + 1) % (last + 1));
    } else if (e.key === "Home" && e.ctrlKey) {
      setActive(0);
    } else if (e.key === "End" && e.ctrlKey) {
      setActive(Math.max(0, last));
    } else if (e.key === "Enter" && current) {
      e.preventDefault();
      if (e.shiftKey) pin(current);
      else runItem(current);
    }
  };

  const enter = level === "reduced" ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -8 };
  const listId = `${id}-list`;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[10vh]">
      <motion.div
        aria-hidden
        className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: DURATION.fast }}
        onClick={onClose}
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("common", P.label)}
        initial={enter}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ ...enter, transition: { duration: DURATION.fast, ease: EASE.exit } }}
        transition={{ duration: DURATION.base, ease: EASE.standard }}
        className="relative flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-card-border bg-card-bg shadow-[0_24px_64px_var(--card-shadow)]"
      >
        <div className="flex items-center gap-3 border-b border-card-border px-4">
          <Search size={18} aria-hidden className="shrink-0 text-text-secondary" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label={t("common", P.label)}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={current ? optionId(current) : undefined}
            dir="auto"
            value={query}
            placeholder={t("common", P.placeholder)}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="h-14 min-w-0 flex-1 bg-transparent text-base text-text-primary placeholder:text-text-secondary focus:outline-none"
          />
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label={t("common", P.results)} className="flex-1 overflow-y-auto p-2">
          {results.length === 0 ? (
            !data.searching && <p className="px-3 py-8 text-center text-sm text-text-secondary">{t("common", P.empty, { query })}</p>
          ) : (
            PALETTE_GROUPS.map((group) => {
              const inGroup = results.filter((r) => r.group === group);
              if (inGroup.length === 0) return null;
              return (
                <div key={group} role="group" aria-label={t("common", GROUP_LABEL[group])} className="mb-1">
                  <p aria-hidden className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wide text-text-secondary">
                    {t("common", GROUP_LABEL[group])}
                  </p>
                  {inGroup.map((item) => {
                    const selected = item === current;
                    const Icon = item.icon;
                    return (
                      <div
                        key={item.key}
                        id={optionId(item)}
                        role="option"
                        aria-selected={selected}
                        data-label={item.label}
                        data-href={item.href}
                        onMouseMove={() => setActive(results.indexOf(item))}
                        onClick={() => runItem(item)}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm",
                          selected ? "bg-leaf-bg text-text-primary" : "text-text-secondary",
                        )}
                      >
                        {Icon && <Icon size={18} aria-hidden className={cn("shrink-0", selected && "text-primary")} />}
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium text-text-primary">{item.label}</span>
                          {item.hint && <span className="ms-2 text-xs text-text-secondary">{item.hint}</span>}
                        </span>
                        {item.pinId && pins.includes(item.pinId) && (
                          <Pin size={14} aria-label={t("common", P.unpin)} className="shrink-0 text-primary" />
                        )}
                        {selected && <CornerDownLeft size={14} aria-hidden className="shrink-0 rtl:-scale-x-100" />}
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <p role="status" className={cn("px-4 pb-2 text-xs text-text-secondary", !data.searching && "sr-only")}>
          {data.searching ? t("common", P.searching) : ""}
        </p>
        <div aria-hidden className="hidden flex-wrap items-center gap-x-4 gap-y-1 border-t border-card-border px-4 py-2 text-[11px] text-text-secondary sm:flex">
          <span><kbd dir="ltr">↑ ↓</kbd> {t("common", P.keys.move)}</span>
          <span><kbd dir="ltr">Enter</kbd> {t("common", P.keys.open)}</span>
          <span><kbd dir="ltr">Shift Enter</kbd> {t("common", P.keys.pin)}</span>
          <span><kbd dir="ltr">Esc</kbd> {t("common", P.keys.close)}</span>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
