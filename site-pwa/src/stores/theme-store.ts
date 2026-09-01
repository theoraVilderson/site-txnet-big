"use client";

import { createStore } from "zustand/vanilla";
import { AVAILABLE_THEMES, type ThemeName } from "@/env";
import { setUserTheme } from "@/services/theme";

export type ThemeChoice = ThemeName | "system";

export interface ThemeState {
  /** تمی که الان واقعاً اعمال شده — همیشه یکی از AVAILABLE_THEMES */
  theme: ThemeName;
  /** انتخاب خود کاربر — می‌تواند "system" باشد */
  choice: ThemeChoice;
}

export interface ThemeActions {
  setTheme: (choice: ThemeChoice) => void;
  /** internal: فقط برای همگام‌سازی با DOM (اسکریپت inline / matchMedia) */
  _syncResolvedTheme: (theme: ThemeName) => void;
}

export type ThemeStore = ThemeState & ThemeActions;
export type ThemeStoreApi = ReturnType<typeof createThemeStore>;

export function isThemeName(v: string | null | undefined): v is ThemeName {
  return !!v && (AVAILABLE_THEMES as readonly string[]).includes(v);
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

export function createThemeStore(initial: ThemeState) {
  return createStore<ThemeStore>()((set) => ({
    ...initial,

    setTheme: (choice) => {
      const resolved: ThemeName =
        choice === "system" ? (systemPrefersDark() ? "dark" : "light") : choice;

      set({ choice, theme: resolved });

      setUserTheme(choice).catch(() => {
        // ذخیره نشدن نباید تجربه کاربر رو خراب کنه؛ تم همچنان توی همین سشن عوض می‌شه
      });
    },

    _syncResolvedTheme: (theme) => set({ theme }),
  }));
}
