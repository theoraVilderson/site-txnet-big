"use client";

import { createContext, useContext, useMemo } from "react";
import { useLocale } from "@/context/LocaleContext";
import type { CompiledTranslation } from "@/stores/locale-store";
import { AUTH_KEY_MAP, type AuthTranslations } from "@auth/auth/_lib/translations";

interface AuthUIContextValue {
  isRtl: boolean;
  /** The active language — the country picker names its countries in it. */
  lang: string;
  /** shorthand: t.<key>  ==  t("auth", key) */
  t: AuthTranslations;
}

const AuthUIContext = createContext<AuthUIContextValue | null>(null);

/** Renders a CompiledTranslation with no vars (odd array slots are var names). */
function renderCompiled(val: CompiledTranslation): string {
  if (typeof val === "string") return val;
  let out = "";
  for (let i = 0; i < val.length; i++) out += i % 2 === 0 ? val[i] : "";
  return out;
}

export function AuthUIProvider({
  children,
  /**
   * The compiled `auth` namespace for EVERY language, resolved on the server by
   * (auth)/layout.tsx: `{ en: { "login.title": … }, fa: { … } }`. Indexed by the
   * current store language so the first (SSR) render already has real strings
   * and client-side language switches read the right language with no fetch.
   */
  authByLang,
}: {
  children: React.ReactNode;
  authByLang?: Record<string, Record<string, CompiledTranslation>>;
}) {
  const { t: lt, isRtl, lang } = useLocale();

  // The proxy closes over the current language + translator instead of reading
  // them out of refs during render (react-hooks/refs); it is rebuilt only when
  // one of them actually changes, so the identity is still stable per language.
  const ns = authByLang?.[lang];

  const t = useMemo(() => {
    return new Proxy({} as AuthTranslations, {
      get(_target, key: string) {
        // components use short flat names (t.loginTitle) → dot path in the
        // nested auth namespace (login.title)
        const path = (AUTH_KEY_MAP as Record<string, string>)[key] ?? key;
        const direct = ns?.[path];
        if (direct !== undefined) return renderCompiled(direct);
        // fallback: live store (e.g. a namespace not passed from the server)
        return lt("auth", path);
      },
    });
  }, [ns, lt]);

  return (
    <AuthUIContext.Provider value={{ isRtl, lang, t }}>
      {children}
    </AuthUIContext.Provider>
  );
}

export function useAuthUI() {
  const ctx = useContext(AuthUIContext);
  if (!ctx) throw new Error("useAuthUI must be used within AuthUIProvider");
  return ctx;
}
