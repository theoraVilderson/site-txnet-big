"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useStore } from "zustand";
import { createThemeStore, type ThemeStoreApi } from "@/stores/theme-store";
import { PREFERS_DARK_QUERY, isThemeName, resolveTheme, type ThemeChoice } from "@/lib/theme";
import type { ThemeName } from "@/env";

export type { ThemeChoice };

const ThemeStoreContext = createContext<ThemeStoreApi | null>(null);

/** Holds the theme store for the tree and keeps <html> in step with it. */
export function ThemeProvider({
  children,
  initialTheme,
  initialChoice,
}: {
  children: ReactNode;
  initialTheme: ThemeName;
  initialChoice: ThemeChoice;
}) {
  // A useState initializer builds the store exactly once per mount, without
  // reading a ref during render (react-hooks/refs).
  const [store] = useState<ThemeStoreApi>(() =>
    createThemeStore({
      theme: initialTheme,
      choice: initialChoice,
    }),
  );

  const theme = useStore(store, (s) => s.theme);
  const choice = useStore(store, (s) => s.choice);

  // On "system" the inline <head> script may already have set the real
  // data-theme before hydration; adopt it so the server's raw initialTheme
  // never fights it.
  useEffect(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    if (isThemeName(attr) && attr !== store.getState().theme) {
      store.getState()._syncResolvedTheme(attr);
    }
    // Once, right after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute("data-theme", theme);
    html.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // On "system", follow the OS when it switches mid-session.
  useEffect(() => {
    if (choice !== "system") return;
    const mq = window.matchMedia(PREFERS_DARK_QUERY);
    const apply = () => store.getState()._syncResolvedTheme(resolveTheme("system", mq.matches));
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [choice, store]);

  return (
    <ThemeStoreContext.Provider value={store}>
      {children}
    </ThemeStoreContext.Provider>
  );
}

export function useTheme() {
  const store = useContext(ThemeStoreContext);
  if (!store) throw new Error("useTheme must be used within ThemeProvider");

  const theme = useStore(store, (s) => s.theme);
  const choice = useStore(store, (s) => s.choice);
  const setTheme = useStore(store, (s) => s.setTheme);

  return { theme, choice, setTheme };
}
