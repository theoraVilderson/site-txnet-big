"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useStore } from "zustand";
import { motion, AnimatePresence } from "framer-motion";
import { setApiLanguage } from "@/lib/api-language";
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
  /** The shared namespaces for every language: lang → ns → key → compiled. */
  initialNamespaces: Record<
    string,
    Record<string, Record<string, CompiledTranslation>>
  >;
  /** The languages on offer, from their metadata. */
  initialAvailable: LocaleMeta[];
}

export function LocaleProvider({
  children,
  initialLang,
  initialDir,
  initialNamespaces,
  initialAvailable,
}: LocaleProviderProps) {
  // Built once per mount; on the server every request has its own React
  // tree, so no state leaks between visitors.
  const [store] = useState<LocaleStoreApi>(() =>
    createLocaleStore({
      lang: initialLang,
      isRtl: initialDir === "rtl",
      availableLocales: initialAvailable,
      // already keyed by language → every language's common/validations are
      // in the store from the first render, so setLang needs no network.
      cache: initialNamespaces,
    }),
  );

  const lang = useStore(store, (s) => s.lang);
  const isRtl = useStore(store, (s) => s.isRtl);
  const isTransitioning = useStore(store, (s) => s.isTransitioning);

  useEffect(() => {
    document.documentElement.dir = isRtl ? "rtl" : "ltr";
    document.documentElement.lang = lang;
    // Same job, one layer out: auth-api reads Accept-Language to decide which
    // language to translate an error into, and the browser's own header names
    // the OS language, not this one.
    setApiLanguage(lang);
  }, [lang, isRtl]);

  return (
    <LocaleStoreContext.Provider value={store}>
      {/*
        No `key={lang}` here: it used to remount the whole children tree on
        a language switch, so a user mid-OTP (step 2, timer running, code
        half typed) lost everything and landed back on step 1.

        Children never remount now. A soft blur overlay, shown only while
        the store's isTransitioning is true, covers the text change so it
        reads as smooth, and no state is lost.
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
              // Fast fade-in (covers the old text), slower fade-out (the new
              // text and direction appear smoothly, no jump).
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

  /**
   * `t` in a language other than the current one — the palette searches every
   * label in English too (UX-1-n). Every language's `common` is in the cache
   * from the first render; another namespace may not be, and reads as its key.
   */
  const tIn = (
    language: string,
    ns: string,
    key: string,
    vars?: Record<string, string | number>,
  ): string => {
    const val = cache[language]?.[ns]?.[key];

    // Only a missing key or namespace falls back to the key: a key whose
    // value is deliberately "" renders empty (a bare `!val` used to show the
    // raw key instead).
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

  const t = (ns: string, key: string, vars?: Record<string, string | number>): string => tIn(lang, ns, key, vars);

  return { lang, isRtl, availableLocales, setLang, addNamespaces, t, tIn };
}
