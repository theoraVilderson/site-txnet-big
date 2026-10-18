import { Logger } from '@nestjs/common';

import type { Translator } from '../translator/translator';

/**
 * An item's name and description in every language — the one writer of item
 * text (ADR-0050 and its amendments; ADR-0154 decision 6).
 *
 * The text is locale-service entries in one namespace under `shareds`, so the
 * panel, the bot and every backend read it the same way. Each item has a
 * **source language** its owner picks; the languages the owner writes are
 * published as written, and every other language locale-service has gets a
 * machine draft from the source, which a human publishes. A draft is never
 * served.
 *
 * What differs per kind of item — the catalog's products, a reseller package —
 * is only the namespace, the shape of its keys and the error a refusal raises:
 * the `ItemTextScheme`. The keys themselves are always derived by the server
 * that owns the item; this writer refuses any key its scheme does not match.
 */

const WRITE_SCOPE = 'shareds';

/** Text by language code, e.g. `{ fa: 'وی‌پی‌ان' }`. */
export type ItemTexts = Record<string, string>;

/** What the writer needs from locale-service — `LocaleService` in production. */
export interface ItemTextStore {
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

/** One draft waiting for review, beside what a reviewer compares it with. */
export type ItemTextDraft = {
  lang: string;
  /** The full i18n key, as the item row holds it. */
  key: string;
  draft: string;
  published: string | null;
  /** The item's source language and its published text there. */
  source: { lang: string; text: string | null };
};

/** Why the writer refused: a key its scheme did not derive, or locale-service not answering. */
export type ItemTextRefusal = 'text_key_invalid' | 'texts_unavailable';

/** What makes one kind of item's text its own: namespace, key shape, refusal error. */
export interface ItemTextScheme {
  /** The locale-service namespace; every full key starts with `<namespace>.`. */
  namespace: string;
  /** A full key the owning server derives — anything else is refused. */
  keyPattern: RegExp;
  /** The owning service's refusal, so its controller maps it like any other. */
  refuse(reason: ItemTextRefusal, detail?: string): Error;
}

/** Publishes, drafts and reviews one kind of item's text through locale-service. */
export class ItemTextWriter {
  private readonly logger: Logger;

  constructor(
    private readonly store: ItemTextStore,
    private readonly translator: Translator,
    private readonly scheme: ItemTextScheme,
  ) {
    this.logger = new Logger(new.target.name);
  }

  /** Languages locale-service has — the only ones a text may be written in (§1.1). */
  languages(): string[] {
    return this.store.languages();
  }

  /** The source language of an item whose owner chose none. */
  defaultLanguage(): string {
    return this.store.getDefaultLanguage();
  }

  /** Publishes the owner's text in each language given; an empty string removes it. Refuses with `texts_unavailable` when locale-service does not answer. */
  async publishSources(texts: { key: string; text: ItemTexts }[]): Promise<void> {
    const byLang = new Map<string, Record<string, string>>();
    for (const t of texts) {
      const entry = this.entryKey(this.valid(t.key));
      for (const [lang, text] of Object.entries(t.text)) {
        byLang.set(lang, { ...(byLang.get(lang) ?? {}), [entry]: text });
      }
    }
    for (const [lang, entries] of byLang) {
      await this.write(() => this.store.setEntries({ scope: WRITE_SCOPE, lang, namespace: this.scheme.namespace, entries }));
    }
  }

  /** Removes a text's published value in every language (a description set to none). */
  async clear(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const entries = Object.fromEntries(keys.map((k) => [this.entryKey(this.valid(k)), '']));
    for (const lang of this.store.languages()) {
      await this.write(() => this.store.setEntries({ scope: WRITE_SCOPE, lang, namespace: this.scheme.namespace, entries }));
    }
  }

  /**
   * Drafts, from the source text, every language the owner did not write.
   * Never throws: it runs after the item's write has committed, and a draft is
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
          if (draft) entries[this.entryKey(t.key)] = draft;
        }
        if (Object.keys(entries).length === 0) continue;
        drafted += await this.store.setEntries({ scope: WRITE_SCOPE, lang, namespace: this.scheme.namespace, entries, draft: true });
      }
      return drafted;
    } catch (e) {
      this.logger.warn(`${this.scheme.namespace} drafts skipped: ${String(e)}`);
      return 0;
    }
  }

  /**
   * "Translate missing": for each item, drafts from its source text every
   * language that has neither published text nor a draft — for a language
   * added after the item was written. An item with no source text is skipped.
   */
  async draftMissing(items: { key: string; from: string }[]): Promise<number> {
    const { namespace } = this.scheme;
    const pending = await this.write(() => this.store.listDrafts({ scope: WRITE_SCOPE, namespace }));
    const waiting = new Set(pending.map((d) => `${d.lang}|${d.key}`));
    let drafted = 0;
    for (const lang of this.store.languages()) {
      const published = this.store.namespace(lang, namespace) ?? {};
      const entries: Record<string, string> = {};
      for (const item of items) {
        const key = this.entryKey(this.valid(item.key));
        if (lang === item.from || published[key] !== undefined || waiting.has(`${lang}|${key}`)) continue;
        const source = this.store.namespace(item.from, namespace)?.[key];
        if (!source) continue;
        const draft = await this.translate(source, item.from, lang);
        if (draft) entries[key] = draft;
      }
      if (Object.keys(entries).length === 0) continue;
      drafted += await this.write(() => this.store.setEntries({ scope: WRITE_SCOPE, lang, namespace, entries, draft: true }));
    }
    return drafted;
  }

  /** Drafts of the given keys (full key → source language), each beside its source text and the text published now. */
  async reviewList(sources: ReadonlyMap<string, string>, lang?: string): Promise<ItemTextDraft[]> {
    const { namespace } = this.scheme;
    const drafts = await this.write(() => this.store.listDrafts({ scope: WRITE_SCOPE, namespace, lang }));
    return drafts.flatMap((d) => {
      const key = this.fullKey(d.key);
      const from = sources.get(key);
      if (from === undefined) return [];
      return [
        {
          lang: d.lang,
          key,
          draft: d.text,
          published: this.store.namespace(d.lang, namespace)?.[d.key] ?? null,
          source: { lang: from, text: this.store.namespace(from, namespace)?.[d.key] ?? null },
        },
      ];
    }).sort((a, b) => a.key.localeCompare(b.key) || a.lang.localeCompare(b.lang));
  }

  /** Publishes drafts as they are. */
  async publishDrafts(lang: string, keys: string[]): Promise<number> {
    const entries = keys.map((k) => this.entryKey(this.valid(k)));
    return this.write(() => this.store.publishDrafts({ scope: WRITE_SCOPE, lang, namespace: this.scheme.namespace, keys: entries }));
  }

  /** Publishes a reviewer's own text in place of a draft (which it drops). */
  async publishEdited(lang: string, texts: Record<string, string>): Promise<number> {
    const entries = Object.fromEntries(Object.entries(texts).map(([k, v]) => [this.entryKey(this.valid(k)), v]));
    return this.write(() => this.store.setEntries({ scope: WRITE_SCOPE, lang, namespace: this.scheme.namespace, entries }));
  }

  private async translate(text: string, from: string, to: string): Promise<string | null> {
    try {
      return await this.translator.translate(text, from, to);
    } catch {
      return null; // the port promises never to throw; a driver that does costs one draft
    }
  }

  private valid(key: string): string {
    if (!this.scheme.keyPattern.test(key)) throw this.scheme.refuse('text_key_invalid', key);
    return key;
  }

  // locale-service stores an entry without its namespace; the item row holds the full key.
  private entryKey(full: string): string {
    return full.slice(this.scheme.namespace.length + 1);
  }

  private fullKey(entry: string): string {
    return `${this.scheme.namespace}.${entry}`;
  }

  // Only a store call runs in here — every key is checked before — so any error is locale-service's.
  private async write<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      this.logger.error(`locale-service write failed: ${String(e)}`);
      throw this.scheme.refuse('texts_unavailable');
    }
  }
}
