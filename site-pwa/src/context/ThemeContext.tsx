"use client";

import { createContext, useContext, useEffect, useRef, ReactNode } from "react";
import { useStore } from "zustand";
import {
  createThemeStore,
  isThemeName,
  type ThemeStoreApi,
  type ThemeChoice,
} from "@/stores/theme-store";
import type { ThemeName } from "@/env";

export type { ThemeChoice };

const ThemeStoreContext = createContext<ThemeStoreApi | null>(null);

export function ThemeProvider({
  children,
  initialTheme,
  initialChoice,
}: {
  children: ReactNode;
  initialTheme: ThemeName;
  initialChoice: ThemeChoice;
}) {
  const storeRef = useRef<ThemeStoreApi | null>(null);
  if (!storeRef.current) {
    storeRef.current = createThemeStore({
      theme: initialTheme,
      choice: initialChoice,
    });
  }
  const store = storeRef.current;

  const theme = useStore(store, (s) => s.theme);
  const choice = useStore(store, (s) => s.choice);

  // اگه انتخاب کاربر "system" باشه، اسکریپت inline توی <head> ممکنه قبل از
  // هیدریت، data-theme واقعی رو (بر اساس matchMedia) روی <html> ست کرده باشه.
  // اینجا همون مقدار رو از DOM می‌خونیم تا با initialTheme خام سرور یکی نشه
  // و هیچ‌وقت میسمچ هیدریت نگیریم.
  useEffect(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    if (isThemeName(attr) && attr !== store.getState().theme) {
      store.getState()._syncResolvedTheme(attr);
    }
    // فقط یک‌بار، بلافاصله بعد از مانت
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute("data-theme", theme);
    html.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // وقتی انتخاب کاربر "system"ه، تغییر لحظه‌ای تم سیستم رو هم دنبال کن
  useEffect(() => {
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      store.getState()._syncResolvedTheme(mq.matches ? "dark" : "light");
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
