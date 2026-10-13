import { createStore } from "zustand/vanilla";
import { setUserLocale } from "@/services/locale";

export type CompiledTranslation = string | string[];

export interface LocaleMeta {
  code: string;
  name: string;
  shortName: string;
  englishName: string;
  dir: "rtl" | "ltr";
  locale: string;
}

// 1. Data only (state with values, no functions). LocaleShell passes exactly
// these fields, except isTransitioning, which always starts false.
export interface LocaleState {
  lang: string;
  isRtl: boolean;
  availableLocales: LocaleMeta[];
  /** Translation cache: lang → ns → key → CompiledTranslation */
  cache: Record<string, Record<string, Record<string, CompiledTranslation>>>;
  /** True while a setLang is fetching or committing — drives the blur overlay. */
  isTransitioning: boolean;
}

// 2. Functions only (the actions that change state).
export interface LocaleActions {
  /** merge per-language namespaces into the cache: lang → ns → key → compiled */
  addNamespaces: (
    byLang: Record<string, Record<string, Record<string, CompiledTranslation>>>,
  ) => void;
  setLang: (newLang: string) => Promise<void>;
}

// 3. The two combined: the store's full shape (Zustand-internal).
export type LocaleStore = LocaleState & LocaleActions;
export type LocaleStoreApi = ReturnType<typeof createLocaleStore>;

/**
 * Flattens and compiles a translation tree, for a language fetched from the
 * API or injected by the server.
 */
export function flattenAndCompile(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, CompiledTranslation> {
  return Object.keys(obj).reduce(
    (acc: Record<string, CompiledTranslation>, k: string) => {
      const pre = prefix.length ? prefix + "." : "";
      const value = obj[k];

      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        Object.assign(
          acc,
          flattenAndCompile(value as Record<string, unknown>, pre + k),
        );
      } else if (typeof value === "string") {
        const text = value;

        // A text with {{var}} becomes a token array.
        if (text.includes("{{")) {
          acc[pre + k] = text.split(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g);
        } else {
          acc[pre + k] = text;
        }
      }
      return acc;
    },
    {},
  );
}

// 4. The store. Its input is LocaleState minus isTransitioning, which is
// internal and always starts false.
export function createLocaleStore(initial: Omit<LocaleState, "isTransitioning">) {
  // Per store instance (each LocaleProvider has its own, so mounts and
  // visitors never mix).
  //
  // Why: switching language quickly several times (e.g. fa → en → fa) left
  // several fetches in flight, and whichever resolved last set the final
  // state — not necessarily the user's last click.
  let latestRequestId = 0;
  let activeAbortController: AbortController | null = null;

  return createStore<LocaleStore>()((set, get) => ({
    // The initial values (lang, isRtl, availableLocales, cache).
    ...initial,
    isTransitioning: false,

    // The actions.
    addNamespaces: (byLang) =>
      set((state) => {
        const cache = { ...state.cache };
        for (const [lng, namespaces] of Object.entries(byLang)) {
          cache[lng] = { ...(cache[lng] || {}), ...namespaces };
        }
        return { cache };
      }),

    setLang: async (newLang: string) => {
      const { lang, cache, availableLocales } = get();
      if (newLang === lang) return;

      // Abort a setLang still fetching: the user has picked another language,
      // so its result is no use.
      activeAbortController?.abort();
      const requestId = ++latestRequestId;
      const controller = new AbortController();
      activeAbortController = controller;

      set({ isTransitioning: true });

      let namespaces = cache[newLang];
      let dir: "rtl" | "ltr";

      try {
        if (namespaces) {
          // Cached — no fetch needed.
          dir = availableLocales.find((m) => m.code === newLang)?.dir ?? "ltr";
        } else {
          const metaRes = await fetch(`/api/i18n/meta`, {
            signal: controller.signal,
          });
          if (metaRes.ok) {
            const { meta } = await metaRes.json();
            dir = meta?.[newLang]?.dir === "rtl" ? "rtl" : "ltr";
          } else {
            dir = "ltr";
          }

          namespaces = {};
          const nsList = Object.keys(cache[lang] ?? {});

          await Promise.all(
            nsList.map(async (ns) => {
              try {
                const res = await fetch(`/api/i18n/${newLang}/${ns}`, {
                  signal: controller.signal,
                });
                if (res.ok) {
                  // Flattened and compiled as it arrives.
                  namespaces![ns] = flattenAndCompile(await res.json());
                }
              } catch {
                /* Skip this namespace (an abort included). */
              }
            }),
          );

          if (Object.keys(namespaces).length === 0) {
            // Nothing loaded — close the overlay if this is still the latest request.
            if (requestId === latestRequestId) set({ isTransitioning: false });
            return;
          }
        }
      } catch {
        // Network error or abort — close the overlay if still the latest request.
        if (requestId === latestRequestId) set({ isTransitioning: false });
        return;
      }

      // A newer setLang was called meanwhile: drop this stale result and
      // commit nothing.
      if (requestId !== latestRequestId) return;

      // The data is usually cached and we arrive here at once. So the switch
      // does not jump: wait for the overlay's blur to settle, swap the text
      // and direction (rtl/ltr) under it, hold a moment for the reflow, then
      // fade the overlay and the new text appears smoothly.
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      await sleep(200);
      if (requestId !== latestRequestId) return;
      set((state) => ({
        lang: newLang,
        isRtl: dir === "rtl",
        cache: { ...state.cache, [newLang]: namespaces! },
      }));

      await sleep(90);
      if (requestId !== latestRequestId) return;
      set({ isTransitioning: false });

      setUserLocale(newLang).catch(() => {
        // A network/server error must not spoil the switch: the language still
        // changes for this session, it just is not kept in the cookie.
      });
    },
  }));
}