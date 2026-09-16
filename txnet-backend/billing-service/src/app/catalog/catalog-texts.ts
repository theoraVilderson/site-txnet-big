import { Inject, Injectable, Logger } from '@nestjs/common';
import { TRANSLATOR, type Translator } from '@txnet-backend/shared-core';

import { CatalogAdminRefused } from './catalog-admin.service';

/**
 * Catalog names and descriptions in every language (F-1533-d; ADR-0050).
 *
 * The text is locale-service entries in the `catalog` namespace under
 * `shareds`, so the panel, the bot and every backend read it the same way. The
 * admin writes `fa` and `en`, published as written; every other language
 * locale-service has gets a machine draft from the English text, which a human
 * publishes. A draft is never served.
 *
 * **The key is the server's** (the user's call, 2026-09-16): a product key is
 * unique only inside a tenant, so a tenant's text sits under `t_<tenant>.` and
 * the platform's has no prefix. Nobody writes a key they did not derive here.
 */

export const CATALOG_NAMESPACE = 'catalog';
const WRITE_SCOPE = 'shareds';
/** The languages an admin writes. Everything else is drafted (ADR-0050 decision 4). */
export const SOURCE_LANGS = ['fa', 'en'] as const;
/** The language drafts are translated from. */
const DRAFT_FROM = 'en';

export type CatalogTextKind = 'category' | 'product';
export type CatalogTextField = 'name' | 'description';
export type Bilingual = { fa: string; en: string };

/** What CatalogTextService needs from locale-service — `LocaleService` in production. */
export interface CatalogTextStore {
  languages(): string[];
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
  /** The full i18n key, as the product row holds it. */
  key: string;
  draft: string;
  published: string | null;
  source: { fa: string | null; en: string | null };
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

  /** Publishes the admin's fa and en text; an empty string removes it. Refuses with `texts_unavailable` when locale-service does not answer. */
  async publishSources(texts: { key: string; text: Bilingual }[]): Promise<void> {
    if (texts.length === 0) return;
    for (const lang of SOURCE_LANGS) {
      const entries = Object.fromEntries(texts.map((t) => [entryKey(this.valid(t.key)), t.text[lang]]));
      await this.write(() => this.store.setEntries({ scope: WRITE_SCOPE, lang, namespace: CATALOG_NAMESPACE, entries }));
    }
  }

  /**
   * Drafts every non-source language from the English text. Never throws: it
   * runs after the catalog write has committed, and a draft is all it can lose.
   */
  async draftOthers(texts: { key: string; en: string }[]): Promise<number> {
    try {
      let drafted = 0;
      for (const lang of this.targetLangs()) {
        const entries: Record<string, string> = {};
        for (const t of texts) {
          const draft = await this.translate(t.en, lang);
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
   * "Translate missing": drafts, for every non-source language, each key the
   * filter allows that has English text but neither published text nor a
   * draft in that language — for a language added after the item was written.
   */
  async draftMissing(allow: (key: string) => boolean): Promise<number> {
    const english = this.store.namespace(DRAFT_FROM, CATALOG_NAMESPACE) ?? {};
    const pending = await this.write(() => this.store.listDrafts({ scope: WRITE_SCOPE, namespace: CATALOG_NAMESPACE }));
    let drafted = 0;
    for (const lang of this.targetLangs()) {
      const published = this.store.namespace(lang, CATALOG_NAMESPACE) ?? {};
      const waiting = new Set(pending.filter((d) => d.lang === lang).map((d) => d.key));
      const entries: Record<string, string> = {};
      for (const [key, en] of Object.entries(english)) {
        const full = fullKey(key);
        if (!parseCatalogTextKey(full) || !allow(full) || published[key] !== undefined || waiting.has(key)) continue;
        const draft = await this.translate(en, lang);
        if (draft) entries[key] = draft;
      }
      if (Object.keys(entries).length === 0) continue;
      drafted += await this.write(() =>
        this.store.setEntries({ scope: WRITE_SCOPE, lang, namespace: CATALOG_NAMESPACE, entries, draft: true }),
      );
    }
    return drafted;
  }

  /** Drafts the filter allows, each beside its fa/en source and the text published now. */
  async reviewList(allow: (key: string) => boolean, lang?: string): Promise<ReviewItem[]> {
    const drafts = await this.write(() => this.store.listDrafts({ scope: WRITE_SCOPE, namespace: CATALOG_NAMESPACE, lang }));
    const fa = this.store.namespace('fa', CATALOG_NAMESPACE) ?? {};
    const en = this.store.namespace('en', CATALOG_NAMESPACE) ?? {};
    return drafts
      .filter((d) => parseCatalogTextKey(fullKey(d.key)) && allow(fullKey(d.key)))
      .map((d) => ({
        lang: d.lang,
        key: fullKey(d.key),
        draft: d.text,
        published: this.store.namespace(d.lang, CATALOG_NAMESPACE)?.[d.key] ?? null,
        source: { fa: fa[d.key] ?? null, en: en[d.key] ?? null },
      }))
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

  private targetLangs(): string[] {
    return this.store.languages().filter((l) => !(SOURCE_LANGS as readonly string[]).includes(l));
  }

  private async translate(text: string, to: string): Promise<string | null> {
    try {
      return await this.translator.translate(text, DRAFT_FROM, to);
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
