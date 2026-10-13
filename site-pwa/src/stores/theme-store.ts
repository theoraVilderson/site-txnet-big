"use client";

import { createStore } from "zustand/vanilla";
import type { ThemeName } from "@/env";
import { resolveTheme, systemPrefersDark, type ThemeChoice } from "@/lib/theme";
import { setUserTheme } from "@/services/theme";

export interface ThemeState {
  /** The theme painted now — always one of AVAILABLE_THEMES. */
  theme: ThemeName;
  /** The user's own pick, which may be "system". */
  choice: ThemeChoice;
}

export interface ThemeActions {
  setTheme: (choice: ThemeChoice) => void;
  /** Internal: follows the DOM (the inline script, the OS listener). */
  _syncResolvedTheme: (theme: ThemeName) => void;
}

export type ThemeStore = ThemeState & ThemeActions;
export type ThemeStoreApi = ReturnType<typeof createThemeStore>;

export function createThemeStore(initial: ThemeState) {
  return createStore<ThemeStore>()((set) => ({
    ...initial,

    setTheme: (choice) => {
      set({ choice, theme: resolveTheme(choice, systemPrefersDark()) });

      setUserTheme(choice).catch(() => {
        // A failed save must not undo the switch; it still holds for this session.
      });
    },

    _syncResolvedTheme: (theme) => set({ theme }),
  }));
}
