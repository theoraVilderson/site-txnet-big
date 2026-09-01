"use client";

import { createContext, useContext, useEffect, useRef, ReactNode } from "react";
import { useStore } from "zustand";
import { motion, AnimatePresence } from "framer-motion";
import {
  createLocaleStore,
  type LocaleStoreApi,
  type LocaleMeta,
  type CompiledTranslation,
} from "@/stores/locale-store";

export type { LocaleMeta };

const LocaleStoreContext = createContext<LocaleStoreApi | null>(null);

interface LocaleProviderProps {
  children: ReactNode;
  initialLang: string;
  initialDir: "rtl" | "ltr";
  /** namespace های عمومی برای همه‌ی زبان‌ها: lang → ns → key → compiled */
  initialNamespaces: Record<
    string,
    Record<string, Record<string, CompiledTranslation>>
  >;
  /** لیست زبان‌های موجود از metadata */
  initialAvailable: LocaleMeta[];
}

export function LocaleProvider({
  children,
  initialLang,
  initialDir,
  initialNamespaces,
  initialAvailable,
}: LocaleProviderProps) {
  // یک‌بار در طول عمر این mount ساخته می‌شه — روی سرور هم چون هر
  // ریکوئست درخت React جدا داره، هیچ استیتی بین کاربرها لو نمی‌ره.
  const storeRef = useRef<LocaleStoreApi | null>(null);
  if (!storeRef.current) {
    storeRef.current = createLocaleStore({
      lang: initialLang,
      isRtl: initialDir === "rtl",
      availableLocales: initialAvailable,
      // already keyed by language → every language's common/validations are
      // in the store from the first render, so setLang needs no network.
      cache: initialNamespaces,
    });
  }
  const store = storeRef.current;

  const lang = useStore(store, (s) => s.lang);
  const isRtl = useStore(store, (s) => s.isRtl);
  const isTransitioning = useStore(store, (s) => s.isTransitioning);

  useEffect(() => {
    document.documentElement.dir = isRtl ? "rtl" : "ltr";
    document.documentElement.lang = lang;
  }, [lang, isRtl]);

  return (
    <LocaleStoreContext.Provider value={store}>
      {/*
        قبلاً اینجا `key={lang}` روی این div بود که باعث می‌شد کل درخت
        children موقع تغییر زبان unmount/remount بشه. یعنی اگه کاربر وسط
        فرم OTP بود (مرحله ۲، تایمر در حال شمارش، کد نیمه‌وارد‌شده)،
        عوض کردن زبان همه‌چیز رو پاک می‌کرد و به مرحله ۱ برمی‌گشت.

        الان children اصلاً remount نمی‌شه. به‌جاش یه overlay بلور نرم
        (که فقط بر اساس isTransitioning از استور نمایش/مخفی می‌شه) روی
        صفحه میفته تا تغییر متن محسوس و نرم باشه، بدون این‌که هیچ استیتی
        از بین بره.
      */}
      <div className="relative w-full min-h-screen">
        {children}
        <AnimatePresence>
          {isTransitioning && (
            <motion.div
              key="locale-transition-overlay"
              initial={{ opacity: 0, backdropFilter: "blur(0px)" }}
              animate={{ opacity: 1, backdropFilter: "blur(10px)" }}
              exit={{ opacity: 0, backdropFilter: "blur(0px)" }}
              // فید-این سریع (متن قدیم را می‌پوشاند)، فید-اوت آرام‌تر
              // (متن جدید + جهت جدید نرم ظاهر می‌شوند، بدون پرش)
              transition={{
                opacity: { duration: 0.18, ease: "easeOut" },
                backdropFilter: { duration: 0.28, ease: "easeInOut" },
              }}
              className="pointer-events-none fixed inset-0 z-[999] bg-black/[0.04] dark:bg-white/[0.04]"
              aria-hidden
            />
          )}
        </AnimatePresence>
      </div>
    </LocaleStoreContext.Provider>
  );
}

export function useLocale() {
  const store = useContext(LocaleStoreContext);
  if (!store) throw new Error("useLocale must be used within LocaleProvider");

  const lang = useStore(store, (s) => s.lang);
  const isRtl = useStore(store, (s) => s.isRtl);
  const availableLocales = useStore(store, (s) => s.availableLocales);
  const cache = useStore(store, (s) => s.cache);
  const setLang = useStore(store, (s) => s.setLang);
  const addNamespaces = useStore(store, (s) => s.addNamespaces);

  const t = (
    ns: string,
    key: string,
    vars?: Record<string, string | number>,
  ): string => {
    const val = cache[lang]?.[ns]?.[key];

    // قبلاً `if (!val) return key` بود — یعنی اگه یه کلید عمداً مقدارش
    // رشته‌ی خالی "" بود، به‌جای نمایش متن خالی، خودِ کلید خام رو نشون
    // می‌داد. فقط باید undefined بودن (یعنی کلید/namespace اصلاً پیدا
    // نشده) رو fallback بگیریم.
    if (val === undefined) return key;

    if (typeof val === "string") {
      return val;
    }

    let result = "";
    for (let i = 0; i < val.length; i++) {
      if (i % 2 === 0) {
        result += val[i];
      } else {
        result += vars?.[val[i]] ?? "";
      }
    }

    return result;
  };

  return { lang, isRtl, availableLocales, setLang, addNamespaces, t };
}
