/**
 * Catalog names in every language (F-1533-d; ADR-0050 decision 4, key scoping
 * the user's call of 2026-09-16).
 *
 * Every rule here is invisible from the product row, which only holds a key:
 *
 *  - **the key is the server's.** A tenant's text lives under its own
 *    `t_<tenant>.` prefix, so two resellers with the same product key never
 *    share a name, and nobody can write over the platform's;
 *  - **fa and en are published as written;** every other language
 *    locale-service has gets a machine draft from the English text, and a
 *    draft is never served;
 *  - **drafting never fails a write** — an engine that is down, slow or has no
 *    model for a pair costs the draft and nothing else;
 *  - **"translate missing" leaves human work alone**: a language that already
 *    has published text, or a draft waiting for review, is not re-drafted.
 */
import type { Translator } from '@txnet-backend/shared-core';

import { CatalogAdminRefused } from './catalog-admin.service';
import { CatalogTextService, CatalogTextStore, catalogTextKey, parseCatalogTextKey } from './catalog-texts';

const TENANT = '22222222-2222-4222-8222-222222222222';

function fakeStore(langs = ['de', 'en', 'fa', 'tr']) {
  const published: Record<string, Record<string, string>> = {};
  const drafts: Record<string, Record<string, string>> = {};
  const calls: string[] = [];
  const state = { fail: false };
  const store: CatalogTextStore = {
    languages: () => langs,
    namespace: (lang, ns) => (ns === 'catalog' ? { ...(published[lang] ?? {}) } : undefined),
    async setEntries({ scope, lang, namespace, entries, draft }) {
      if (state.fail) throw new Error('14 UNAVAILABLE');
      calls.push(`${draft ? 'draft' : 'publish'} ${scope}/${namespace} ${lang}: ${Object.keys(entries).sort().join(',')}`);
      const target = draft ? drafts : published;
      target[lang] ??= {};
      for (const [k, v] of Object.entries(entries)) {
        if (v === '') delete target[lang][k];
        else target[lang][k] = v;
        if (!draft) delete drafts[lang]?.[k];
      }
      return Object.values(entries).filter(Boolean).length;
    },
    async listDrafts({ lang } = {}) {
      return Object.entries(drafts)
        .filter(([l]) => !lang || l === lang)
        .flatMap(([l, entries]) => Object.entries(entries).map(([key, text]) => ({ scope: 'shareds', lang: l, namespace: 'catalog', key, text })));
    },
    async publishDrafts({ lang, keys }) {
      if (state.fail) throw new Error('14 UNAVAILABLE');
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
  return { store, published, drafts, calls, state };
}

/** Knows every pair but `tr`; `broken` throws, as a driver must never. */
function fakeTranslator(opts: { broken?: boolean } = {}): Translator & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async translate(text, from, to) {
      asked.push(`${from}>${to}`);
      if (opts.broken) throw new Error('engine exploded');
      return to === 'tr' ? null : `[${to}] ${text}`;
    },
    async languages() {
      return [];
    },
  };
}

describe('catalog text keys', () => {
  it("scopes a tenant's key under its own prefix and leaves the platform's plain", () => {
    expect(catalogTextKey(null, 'product', 'vpn', 'name')).toBe('catalog.product.vpn.name');
    expect(catalogTextKey(TENANT, 'product', 'vpn', 'name')).toBe('catalog.t_22222222222242228222222222222222.product.vpn.name');
    expect(catalogTextKey(TENANT, 'category', 'vpn', 'name')).not.toBe(catalogTextKey(null, 'category', 'vpn', 'name'));
  });

  it('parses what it builds, and nothing else', () => {
    const key = catalogTextKey(TENANT, 'product', 'vpn_pro', 'description');
    expect(parseCatalogTextKey(key)).toEqual({ tenantId: TENANT, kind: 'product', key: 'vpn_pro', field: 'description' });
    expect(parseCatalogTextKey('catalog.category.vpn.name')).toEqual({ tenantId: null, kind: 'category', key: 'vpn', field: 'name' });
    for (const bad of ['errors.auth.x', 'catalog.product.vpn', 'catalog.t_nothex.product.vpn.name', 'catalog.variant.x.name', 'catalog.product.vpn.name.extra']) {
      expect(parseCatalogTextKey(bad)).toBeNull();
    }
  });
});

describe('CatalogTextService — writing a name', () => {
  it('publishes fa and en as written, into shareds/catalog', async () => {
    const { store, published, calls } = fakeStore();
    const texts = new CatalogTextService(store, fakeTranslator());
    const key = catalogTextKey(null, 'product', 'vpn', 'name');

    await texts.publishSources([{ key, text: { fa: 'وی‌پی‌ان', en: 'VPN' } }]);

    expect(published['fa']).toEqual({ 'product.vpn.name': 'وی‌پی‌ان' });
    expect(published['en']).toEqual({ 'product.vpn.name': 'VPN' });
    expect(calls).toEqual(['publish shareds/catalog fa: product.vpn.name', 'publish shareds/catalog en: product.vpn.name']);
  });

  it('answers a locale-service that cannot be reached as its own refusal', async () => {
    const { store, state } = fakeStore();
    state.fail = true;
    const texts = new CatalogTextService(store, fakeTranslator());
    const refused = await texts.publishSources([{ key: 'catalog.product.vpn.name', text: { fa: 'x', en: 'x' } }]).catch((e) => e);
    expect(refused).toBeInstanceOf(CatalogAdminRefused);
    expect(refused.reason).toBe('texts_unavailable');
  });

  it('drafts every other language from English, and never a source language', async () => {
    const { store, drafts, published } = fakeStore();
    const translator = fakeTranslator();
    const texts = new CatalogTextService(store, translator);

    const drafted = await texts.draftOthers([{ key: 'catalog.product.vpn.name', en: 'VPN' }]);

    expect(drafted).toBe(1);
    expect(drafts['de']).toEqual({ 'product.vpn.name': '[de] VPN' });
    expect(drafts['tr']).toBeUndefined(); // no model for the pair: no draft
    expect(translator.asked.sort()).toEqual(['en>de', 'en>tr']);
    expect(published).toEqual({});
  });

  it('never fails the write it follows — a broken engine or store costs the draft only', async () => {
    const broken = new CatalogTextService(fakeStore().store, fakeTranslator({ broken: true }));
    await expect(broken.draftOthers([{ key: 'catalog.product.vpn.name', en: 'VPN' }])).resolves.toBe(0);

    const { store, state } = fakeStore();
    state.fail = true;
    const unreachable = new CatalogTextService(store, fakeTranslator());
    await expect(unreachable.draftOthers([{ key: 'catalog.product.vpn.name', en: 'VPN' }])).resolves.toBe(0);
  });
});

describe('CatalogTextService — review', () => {
  it('"translate missing" drafts only languages with neither published text nor a draft', async () => {
    const { store, published, drafts } = fakeStore(['de', 'en', 'fa', 'fr']);
    published['en'] = { 'product.vpn.name': 'VPN', 'product.api.name': 'API' };
    published['fa'] = { 'product.vpn.name': 'وی‌پی‌ان', 'product.api.name': 'ای‌پی‌آی' };
    published['de'] = { 'product.vpn.name': 'VPN (von Hand)' };
    drafts['fr'] = { 'product.vpn.name': 'VPN (brouillon)' };
    const texts = new CatalogTextService(store, fakeTranslator());

    const drafted = await texts.draftMissing(() => true);

    expect(drafted).toBe(2); // de api, fr api
    expect(published['de']['product.vpn.name']).toBe('VPN (von Hand)');
    expect(drafts['de']).toEqual({ 'product.api.name': '[de] API' });
    expect(drafts['fr']).toEqual({ 'product.vpn.name': 'VPN (brouillon)', 'product.api.name': '[fr] API' });
  });

  it('"translate missing" only reaches the keys the filter allows', async () => {
    const { store, published, drafts } = fakeStore(['de', 'en', 'fa']);
    const mine = catalogTextKey(TENANT, 'product', 'vpn', 'name');
    published['en'] = { 'product.vpn.name': 'Platform VPN', [mine.slice('catalog.'.length)]: 'My VPN' };
    const texts = new CatalogTextService(store, fakeTranslator());

    await texts.draftMissing((key) => parseCatalogTextKey(key)?.tenantId === TENANT);

    expect(Object.keys(drafts['de'])).toEqual([mine.slice('catalog.'.length)]);
  });

  it('lists a draft beside its fa and en source and what is published now', async () => {
    const { store, published, drafts } = fakeStore();
    published['en'] = { 'product.vpn.name': 'VPN' };
    published['fa'] = { 'product.vpn.name': 'وی‌پی‌ان' };
    published['de'] = { 'product.vpn.name': 'Alt' };
    drafts['de'] = { 'product.vpn.name': '[de] VPN', 'errors.junk': 'not catalog text' };
    const texts = new CatalogTextService(store, fakeTranslator());

    expect(await texts.reviewList(() => true)).toEqual([
      { lang: 'de', key: 'catalog.product.vpn.name', draft: '[de] VPN', published: 'Alt', source: { fa: 'وی‌پی‌ان', en: 'VPN' } },
    ]);
  });

  it('publishes a draft as it is, or an edited text in its place', async () => {
    const { store, published, drafts } = fakeStore();
    drafts['de'] = { 'product.vpn.name': '[de] VPN', 'product.api.name': '[de] API' };
    const texts = new CatalogTextService(store, fakeTranslator());

    await expect(texts.publishDrafts('de', ['catalog.product.vpn.name'])).resolves.toBe(1);
    await expect(texts.publishEdited('de', { 'catalog.product.api.name': 'Schnittstelle' })).resolves.toBe(1);

    expect(published['de']).toEqual({ 'product.vpn.name': '[de] VPN', 'product.api.name': 'Schnittstelle' });
    expect(drafts['de']).toEqual({});
  });
});
