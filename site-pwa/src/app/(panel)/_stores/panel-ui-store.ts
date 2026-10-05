"use client";

import { create } from "zustand";

/**
 * The shell's own UI state (F-093-a) — nothing here is data, and nothing
 * survives a reload. The sidebar's collapse, its folded sections and its pins
 * are not here: they are the person's `ui.sidebar` and `ui.pins` (UX-1-l,
 * UX-1-m, `@/stores/ui-preferences-store`). A module singleton on purpose: the panel has exactly one
 * shell, and the top bar's menu button and the sidebar it opens are siblings
 * that would otherwise need a provider just to share one boolean.
 */
export interface PanelUiState {
  /** Below `lg` only: the sidebar is an off-canvas drawer, and this opens it. */
  drawerOpen: boolean;
  /** One submenu open at a time, by group id. */
  openGroupId: string | null;
  /** The command palette (UX-1-n): Ctrl/⌘+K, the top bar's button, not-found's. */
  paletteOpen: boolean;
  /** The gift-code modal (F-093-g): the wallet's quick action, or the palette's. */
  giftCodeOpen: boolean;

  setDrawerOpen: (open: boolean) => void;
  toggleGroup: (id: string) => void;
  openGroup: (id: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setGiftCodeOpen: (open: boolean) => void;
}

export const usePanelUiStore = create<PanelUiState>((set) => ({
  drawerOpen: false,
  openGroupId: null,
  paletteOpen: false,
  giftCodeOpen: false,

  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  toggleGroup: (id) =>
    set((s) => ({ openGroupId: s.openGroupId === id ? null : id })),
  openGroup: (id) => set({ openGroupId: id }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setGiftCodeOpen: (giftCodeOpen) => set({ giftCodeOpen }),
}));
