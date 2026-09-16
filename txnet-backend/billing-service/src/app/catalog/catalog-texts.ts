import { Inject, Injectable, Logger } from '@nestjs/common';
import { TRANSLATOR, type Translator } from '@txnet-backend/shared-core';

import { CatalogAdminRefused } from './catalog-admin.service';

/**
 * Catalog names and descriptions in every language (F-1533-d/f; ADR-0050 and
 * its amendments of 2026-09-16).
 *
 * The text is locale-service entries in the `catalog` namespace under
 * `shareds`, so the panel, the bot and every backend read it the same way.
 * Each item has a **source language** the admin picks (default
 * `DEFAULT_LANGUAGE`); the languages the admin writes are published as
 * written, and every other language locale-service has gets a machine draft
 * from the source, which a human publishes. A draft is never served. A reader
 * falls back from the requested language to the item's source language.
 *
 * **The key is the server's** (the user's call, 2026-09-16): a product key is
 * unique only inside a tenant, so a tenant's text sits under `t_<tenant>.` and
 * the platform's has no prefix. Nobody writes a key they did not derive here.
 */

export const CATALOG_NAMESPACE = 'catalog';
const WRITE_SCOPE = 'shareds';

export type CatalogTextKind = 'category' | 'product';
export type CatalogTextField = 'name' | 'description';
/** Text by language code, e.g. `{ fa: 'وی‌پی‌ان' }`. */
export type Texts = Record<string, string>;

/** What CatalogTextService needs from locale-service — `LocaleService` in production. */
export interface CatalogTextStore {
  languages(): string[];
  /** `DEFAULT_LANGUAGE`: an item's source language when none was chosen. */
  getDefaultLanguage(): string;
  /** Published entries of one language's namespace, without fallback. */
  namespace(lang: string, namespace: string): Record<string, string> | undefined;
  setEntries(target: { scope: string; lang: string; namespace: string; entries: Record<string, string>; draft?: boolean }): Promise<number>;
  listDrafts(filter?: { scope?: string; lang?: string; namespace?: string; keyPrefix?: string }): Promise<
    { scope: string; lang: string; namespace: string; key: string; text: string }[]
  >;
  publishDrafts(target: { scope: string; lang: string; namespace: string; keys: string[] }): Promise<number>;
}

export const CATALOG_TEXT_STORE = Symbol('CATALOG_TEXT_STORE');

/** One draft waiting for review, beside what a reviewer compares it with. */
export type ReviewItem = {
  lang: string;
  /** The full i18n key, as the item row holds it. */
  key: string;
  draft: string;
  published: string | null;
  /** The item's source language and its published text there. */
  source: { lang: string; text: string | null };
};

const KEY_RE = /^catalog\.(?:t_([0-9a-f]{32})\.)?(category|product)\.([a-z][a-z0-9_]{1,63})\.(name|description)$/;

const hex = (uuid: string) => uuid.replace(/-/g, '').toLowerCase();
const uuidOf = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

/** The i18n key of an item's text: `catalog.[t_<tenant>.]<kind>.<key>.<field>`. */
export function catalogTextKey(tenantId: string | null, kind: CatalogTextKind, key: string, field: CatalogTextField): string {
  return `${CATALOG_NAMESPACE}.${tenantId ? `t_${hex(tenantId)}.` : ''}${kind}.${key}.${field}`;
}

/** The parts of a key `catalogTextKey` built, or `null` for anything else. */
export function parseCatalogTextKey(
  full: string,
): { tenantId: string | null; kind: CatalogTextKind; key: string; field: CatalogTextField } | null {
  const m = KEY_RE.exec(full);
  if (!m) return null;
  return { tenantId: m[1] ? uuidOf(m[1]) : null, kind: m[2] as CatalogTextKind, key: m[3], field: m[4] as CatalogTextField };
}

const entryKey = (full: string) => full.slice(CATALOG_NAMESPACE.length + 1);
const fullKey = (entry: string) => `${CATALOG_NAMESPACE}.${entry}`;

@Injectable()
export class CatalogTextService {
  private readonly logger = new Logger(CatalogTextService.name);

  constructor(
    @Inject(CATALOG_TEXT_STORE) private readonly store: CatalogTextStore,
    @Inject(TRANSLATOR) private readonly translator: Translator,
  ) {}

  /** Languages locale-service has — the only ones a text may be written in (§1.1). */
  languages(): string[] {
    return this.store.languages();
  }

  defaultLanguage(): string {
    return this.store.getDefaultLanguage();
  }

  /** Publishes the admin's text in each language given; an empty string removes it. Refuses with `texts_unavailable` when locale-service does not answer. */
  async publishSources(texts: { key: string; text: Texts }[]): Promise<void> {
    const byLang = new Map<string, Record<string, string>>();
    for (const t of texts) {
      const entry = entryKey(this.valid(t.key));
      for (const [lang, text] of Object.entries(t.text)) {
        byLang.set(lang, { ...(byLang.get(lang) ?? {}), [entry]: text });
      }
    }
    for (const [lang, entries] of byLang) {
      await this.write(() => this.store.setEntries({ scope: WRITE_SCOPE, lang, namespace: CATALOG_NAMESPACE, entries }));
    }
  }

  /** Removes a text's published value in every language (a description set to none). */
  async clear(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const entries = Object.fromEntries(keys.map((k) => [entryKey(this.valid(k)), '']));
    for (const lang of this.store.languages()) {
      await this.write(() => this.store.setEntries({ scope: WRITE_SCOPE, lang, namespace: CATALOG_NAMESPACE, entries }));
    }
  }

  /**
   * Drafts, from the source text, every language the admin did not write.
   * Never throws: it runs after the catalog write has committed, and a draft is
   * all it can lose.
   */
  async draftOthers(texts: { key: string; from: string; text: string; written: string[] }[]): Promise<number> {
    try {
      let drafted = 0;
      for (const lang of this.store.languages()) {
        const entries: Record<string, string> = {};
        for (const t of texts) {
          if (t.written.includes(lang) || lang === t.from) continue;
          const draft = await this.translate(t.text, t.from, lang);
          if (draft) entries[entryKey(t.key)] = draft;
        }
        if (Object.keys(entries).length === 0) continue;
        drafted += await this.store.setEntries({ scope: WRITE_SCOPE, lang, namespace: CATALOG_NAMESPACE, entries, draft: true });
      }
      return drafted;
    } catch (e) {
      this.logger.warn(`catalog drafts skipped: ${String(e)}`);
      return 0;
    }
  }

  /**
   * "Translate missing": for each item, drafts from its source text every
   * language that has neither published text nor a draft — for a language
   * added after the item was written. An item with no source text is skipped.
   */
  async draftMissing(items: { key: string; from: string }[]): Promise<number> {
    const pending = await this.write(() => this.store.listDrafts({ scope: WRITE_SCOPE, namespace: CATALOG_NAMESPACE }));
    const waiting = new Set(pending.map((d) => `${d.lang}|${d.key}`));
    let drafted = 0;
    for (const lang of this.store.languages()) {
      const published = this.store.namespace(lang, CATALOG_NAMESPACE) ?? {};
      const entries: Record<string, string> = {};
      for (const item of items) {
        const key = entryKey(this.valid(item.key));
        if (lang === item.from || published[key] !== undefined || waiting.has(`${lang}|${key}`)) continue;
        const source = this.store.namespace(item.from, CATALOG_NAMESPACE)?.[key];
        if (!source) continue;
        const draft = await this.translate(source, item.from, lang);
        if (draft) entries[key] = draft;
      }
      if (Object.keys(entries).length === 0) continue;
      drafted += await this.write(() =>
        this.store.setEntries({ scope: WRITE_SCOPE, lang, namespace: CATALOG_NAMESPACE, entries, draft: true }),
      );
    }
    return drafted;
  }

  /** Drafts of the given keys (full key → source language), each beside its source text and the text published now. */
  async reviewList(sources: ReadonlyMap<string, string>, lang?: string): Promise<ReviewItem[]> {
    const drafts = await this.write(() => this.store.listDrafts({ scope: WRITE_SCOPE, namespace: CATALOG_NAMESPACE, lang }));
    return drafts
      .filter((d) => sources.has(fullKey(d.key)))
      .map((d) => {
        const from = sources.get(fullKey(d.key)) as string;
        return {
          lang: d.lang,
          key: fullKey(d.key),
          draft: d.text,
          published: this.store.namespace(d.lang, CATALOG_NAMESPACE)?.[d.key] ?? null,
          source: { lang: from, text: this.store.namespace(from, CATALOG_NAMESPACE)?.[d.key] ?? null },
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key) || a.lang.localeCompare(b.lang));
  }

  /** Publishes drafts as they are. */
  async publishDrafts(lang: string, keys: string[]): Promise<number> {
    const entries = keys.map((k) => entryKey(this.valid(k)));
    return this.write(() => this.store.publishDrafts({ scope: WRITE_SCOPE, lang, namespace: CATALOG_NAMESPACE, keys: entries }));
  }

  /** Publishes a reviewer's own text in place of a draft (which it drops). */
  async publishEdited(lang: string, texts: Record<string, string>): Promise<number> {
    const entries = Object.fromEntries(Object.entries(texts).map(([k, v]) => [entryKey(this.valid(k)), v]));
    return this.write(() => this.store.setEntries({ scope: WRITE_SCOPE, lang, namespace: CATALOG_NAMESPACE, entries }));
  }

  private async translate(text: string, from: string, to: string): Promise<string | null> {
    try {
      return await this.translator.translate(text, from, to);
    } catch {
      return null; // the port promises never to throw; a driver that does costs one draft
    }
  }

  private valid(key: string): string {
    if (!parseCatalogTextKey(key)) throw new CatalogAdminRefused('text_key_invalid', key);
    return key;
  }

  private async write<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof CatalogAdminRefused) throw e;
      this.logger.error(`locale-service write failed: ${String(e)}`);
      throw new CatalogAdminRefused('texts_unavailable');
    }
  }
}
