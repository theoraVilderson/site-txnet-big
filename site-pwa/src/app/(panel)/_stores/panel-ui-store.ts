"use client";

import { create } from "zustand";

/**
 * The shell's own UI state (F-093-a) — nothing here is data, and nothing
 * survives a reload. A module singleton on purpose: the panel has exactly one
 * shell, and the top bar's menu button and the sidebar it opens are siblings
 * that would otherwise need a provider just to share one boolean.
 */
export interface PanelUiState {
  /** Desktop only: the sidebar shows icons, with the label as a tooltip. */
  collapsed: boolean;
  /** Below `lg` only: the sidebar is an off-canvas drawer, and this opens it. */
  drawerOpen: boolean;
  /** One submenu open at a time, by group id. */
  openGroupId: string | null;

  toggleCollapsed: () => void;
  setCollapsed: (collapsed: boolean) => void;
  setDrawerOpen: (open: boolean) => void;
  toggleGroup: (id: string) => void;
  openGroup: (id: string) => void;
}

export const usePanelUiStore = create<PanelUiState>((set) => ({
  collapsed: false,
  drawerOpen: false,
  openGroupId: null,

  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
  setCollapsed: (collapsed) => set({ collapsed }),
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  toggleGroup: (id) =>
    set((s) => ({ openGroupId: s.openGroupId === id ? null : id })),
  openGroup: (id) => set({ openGroupId: id }),
}));
