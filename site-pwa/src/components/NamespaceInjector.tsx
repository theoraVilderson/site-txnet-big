// components/NamespaceInjector.tsx
"use client";

import { useRef } from "react";
import { useLocale } from "@/context/LocaleContext";
import type { CompiledTranslation } from "@/stores/locale-store";

export function NamespaceInjector({
  namespaces,
}: {
  /** lang → ns → key → compiled  (pass every language so switching needs no fetch) */
  namespaces: Record<
    string,
    Record<string, Record<string, CompiledTranslation>>
  >;
}) {
  const { addNamespaces } = useLocale();
  const injected = useRef(false);

  // useRef so React Strict Mode doesn't inject twice. The namespaces must be
  // in the store *before* siblings render (they read them on the first paint),
  // so this deliberately runs during render, not in an effect.
  // eslint-disable-next-line react-hooks/refs
  if (!injected.current) {
    addNamespaces(namespaces);
    injected.current = true;
  }

  return null;
}
