// components/NamespaceInjector.tsx
"use client";

import { useEffect, useRef } from "react";
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

  // This used to run during render, on the theory that siblings read the
  // namespaces on their first paint. They do not: the screens under (auth) get
  // every language's `auth` namespace as a prop from the server layout, via
  // AuthUIProvider. Nothing reads it out of the store before this effect runs.
  //
  // Running it during render was a real fault, not a style point:
  // `addNamespaces` replaces `state.cache`, and both this component and its
  // ancestor AuthUIProvider subscribe to `cache` through useSyncExternalStore.
  // Writing it mid-render therefore updates components React has already
  // rendered in the same pass — the "Cannot update a component while rendering
  // a different component" error, thrown from the `set` in locale-store.
  //
  // The ref keeps Strict Mode's double-invoked effect from merging twice (the
  // merge is idempotent, but it would rebuild `cache` and re-render every
  // subscriber for nothing).
  useEffect(() => {
    if (injected.current) return;
    injected.current = true;
    addNamespaces(namespaces);
  }, [addNamespaces, namespaces]);

  return null;
}
