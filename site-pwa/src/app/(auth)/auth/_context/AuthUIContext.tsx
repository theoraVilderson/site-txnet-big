"use client";

import { createContext, useContext, useMemo, useRef } from "react";
import { useLocale } from "@/context/LocaleContext";
import type { CompiledTranslation } from "@/stores/locale-store";
import { AUTH_KEY_MAP, type AuthTranslations } from "@auth/auth/_lib/translations";

interface AuthUIContextValue {
  isRtl: boolean;
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

  const ltRef = useRef(lt);
  ltRef.current = lt;
  const nsRef = useRef<Record<string, CompiledTranslation> | undefined>(
    authByLang?.[lang],
  );
  nsRef.current = authByLang?.[lang];

  const t = useMemo(() => {
    return new Proxy({} as AuthTranslations, {
      get(_target, key: string) {
        // components use short flat names (t.loginTitle) → dot path in the
        // nested auth namespace (login.title)
        const path = (AUTH_KEY_MAP as Record<string, string>)[key] ?? key;
        const direct = nsRef.current?.[path];
        if (direct !== undefined) return renderCompiled(direct);
        // fallback: live store (e.g. a namespace not passed from the server)
        return ltRef.current("auth", path);
      },
    });
  }, []);

  return (
    <AuthUIContext.Provider value={{ isRtl, t }}>
      {children}
    </AuthUIContext.Provider>
  );
}

export function useAuthUI() {
  const ctx = useContext(AuthUIContext);
  if (!ctx) throw new Error("useAuthUI must be used within AuthUIProvider");
  return ctx;
}
