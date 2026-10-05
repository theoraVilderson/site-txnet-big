"use client";

import { create } from "zustand";

/**
 * Which sections are folded (UX-1-j, N2), kept on this device until UX-1-m
 * moves them to the person's `ui.sidebar.closedSections`. Every read and
 * write is guarded: storage may be absent or refuse (a private window).
 */
const CLOSED_SECTIONS_KEY = "txnet.panel.closedSections";

function readClosedSections(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CLOSED_SECTIONS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeClosedSections(ids: string[]): void {
  try {
    localStorage.setItem(CLOSED_SECTIONS_KEY, JSON.stringify(ids));
  } catch {
    // Not kept; the fold still holds for this visit.
  }
}

/**
 * The shell's own UI state (F-093-a) — nothing here is data, and nothing
 * survives a reload but the folded sections. The sidebar's collapse is not
 * here: it is the person's `ui.sidebar.collapsed` (UX-1-l,
 * `@/stores/ui-preferences-store`). A module singleton on purpose: the panel has exactly one
 * shell, and the top bar's menu button and the sidebar it opens are siblings
 * that would otherwise need a provider just to share one boolean.
 */
export interface PanelUiState {
  /** Below `lg` only: the sidebar is an off-canvas drawer, and this opens it. */
  drawerOpen: boolean;
  /** One submenu open at a time, by group id. */
  openGroupId: string | null;
  /** The sections folded shut (N2), by section id. */
  closedSections: string[];

  setDrawerOpen: (open: boolean) => void;
  toggleGroup: (id: string) => void;
  openGroup: (id: string) => void;
  toggleSection: (id: string) => void;
  /** Reads this device's folds; the sidebar calls it once on mount, so the server render matches. */
  loadClosedSections: () => void;
}

export const usePanelUiStore = create<PanelUiState>((set) => ({
  drawerOpen: false,
  openGroupId: null,
  closedSections: [],

  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  toggleGroup: (id) =>
    set((s) => ({ openGroupId: s.openGroupId === id ? null : id })),
  openGroup: (id) => set({ openGroupId: id }),
  toggleSection: (id) =>
    set((s) => {
      const closedSections = s.closedSections.includes(id)
        ? s.closedSections.filter((c) => c !== id)
        : [...s.closedSections, id];
      writeClosedSections(closedSections);
      return { closedSections };
    }),
  loadClosedSections: () => set({ closedSections: readClosedSections() }),
}));
