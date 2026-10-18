import type { ItemTextStore, Translator } from '@txnet-backend/shared-core';

/**
 * locale-service's text overlay in memory, for a service that writes item text
 * through shared-core's `ItemTextWriter` (ADR-0154 decision 6). Published and
 * draft entries by language, as the overlay keeps them under one namespace;
 * `fail` makes every write throw as an unreachable locale-service does.
 */
export function memoryItemTextStore(namespace: string, langs: string[], defaultLanguage: string) {
  const published: Record<string, Record<string, string>> = {};
  const drafts: Record<string, Record<string, string>> = {};
  const state = { fail: false };
  const unreachable = () => {
    if (state.fail) throw new Error('14 UNAVAILABLE');
  };
  const store: ItemTextStore = {
    languages: () => langs,
    getDefaultLanguage: () => defaultLanguage,
    namespace: (lang, ns) => (ns === namespace ? { ...(published[lang] ?? {}) } : undefined),
    async setEntries({ lang, entries, draft }) {
      unreachable();
      const target = (draft ? drafts : published)[lang] ?? {};
      for (const [k, v] of Object.entries(entries)) {
        if (v === '') delete target[k];
        else target[k] = v;
        if (!draft) delete drafts[lang]?.[k];
      }
      (draft ? drafts : published)[lang] = target;
      return Object.values(entries).filter(Boolean).length;
    },
    async listDrafts({ lang } = {}) {
      unreachable();
      return Object.entries(drafts)
        .filter(([l]) => !lang || l === lang)
        .flatMap(([l, entries]) => Object.entries(entries).map(([key, text]) => ({ scope: 'shareds', lang: l, namespace, key, text })));
    },
    async publishDrafts({ lang, keys }) {
      unreachable();
      let moved = 0;
      for (const k of keys) {
        const text = drafts[lang]?.[k];
        if (text === undefined) continue;
        (published[lang] ??= {})[k] = text;
        delete drafts[lang][k];
        moved++;
      }
      return moved;
    },
  };
  return { store, published, drafts, state };
}

/** A translator that drafts `[from>to] text` for every pair. */
export const markingTranslator: Translator = {
  translate: async (text, from, to) => `[${from}>${to}] ${text}`,
  languages: async () => [],
};
