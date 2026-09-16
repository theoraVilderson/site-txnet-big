"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Languages, Loader2, RotateCw, Send, Wand2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { catalogApi, type TranslationDraft } from "@/lib/catalog-api";
import { PANEL_CATALOG } from "@/lib/routes";
import { Select } from "../../_components/kit/Select";
import { CATALOG_KEYS, DESCRIPTION_MAX, editId, refusalKey, reviewLanguages, reviewWrites } from "../_lib/catalog-form";

const K = CATALOG_KEYS.translations;
const input = "w-full rounded-xl border border-card-border bg-bg-inner px-3 py-2 text-sm text-text-primary outline-none focus:border-primary";
const primaryButton = "inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-bold text-white shadow-sm disabled:opacity-50";
const quietButton = "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-primary hover:bg-[var(--leaf-bg)] disabled:opacity-50";

/**
 * Catalog translation review (F-1533-e; ADR-0050 decisions 3-4).
 *
 * A draft is a machine's text and is never shown to a user until a person
 * publishes it here: as it is, or edited. Each draft sits beside the fa and en
 * text it came from and what is published now. "Translate missing" drafts a
 * language added after the item was written. Billing limits every call to the
 * caller's own items (the platform owner: all), so this page filters nothing.
 */
export function TranslationsView() {
  const { t, availableLocales } = useLocale();
  const errorMessage = useApiErrorMessage();
  const message = (e: unknown) => {
    const key = refusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
  const [lang, setLang] = useState("");
  const [drafts, setDrafts] = useState<TranslationDraft[] | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDrafts(await catalogApi.translations(lang || undefined));
      setEdits({});
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [lang]);

  useEffect(() => {
    // Every setState in load runs after its first await, as in `CatalogView`.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const run = async (act: () => Promise<string>) => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      setNotice(await act());
      await load();
    } catch (e) {
      setActionError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const publish = (items: TranslationDraft[]) =>
    run(async () => {
      let published = 0;
      for (const w of reviewWrites(items, edits)) {
        published += w.texts
          ? (await catalogApi.editTranslations(w.lang, w.texts)).published
          : (await catalogApi.publishTranslations(w.lang, w.keys)).published;
      }
      return t("common", K.published, { count: published });
    });

  const draftMissing = () =>
    run(async () => {
      const { drafted } = await catalogApi.draftMissing();
      return drafted ? t("common", K.drafted, { count: drafted }) : t("common", K.noneMissing);
    });

  const dirOf = (code: string) => availableLocales.find((l) => l.code === code)?.dir ?? "ltr";
  const nameOf = (code: string) => availableLocales.find((l) => l.code === code)?.name ?? code;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-text-primary">
            <Languages size={18} className="text-primary" aria-hidden />
            {t("common", K.title)}
          </h1>
          <p className="text-xs text-text-secondary">{t("common", K.subtitle)}</p>
        </div>
        <Link href={PANEL_CATALOG} className={quietButton}>
          <ArrowRight size={14} className="ltr:rotate-180" aria-hidden />
          {t("common", K.back)}
        </Link>
      </header>

      <div className="flex flex-wrap items-end justify-between gap-2">
        <Select
          ariaLabel={t("common", K.language)}
          value={lang}
          onChange={setLang}
          options={[
            { value: "", label: t("common", K.allLanguages) },
            ...reviewLanguages(availableLocales.map((l) => l.code)).map((code) => ({ value: code, label: nameOf(code) })),
          ]}
          className="w-44"
        />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={quietButton} disabled={busy} onClick={() => void draftMissing()}>
            <Wand2 size={14} aria-hidden />
            {t("common", K.draftMissing)}
          </button>
          {drafts && drafts.length > 0 && (
            <button type="button" className={primaryButton} disabled={busy} onClick={() => void publish(drafts)}>
              <Send size={14} aria-hidden />
              {t("common", K.publishAll)}
            </button>
          )}
        </div>
      </div>

      {notice && <p className="text-xs font-bold text-primary">{notice}</p>}
      {actionError && (
        <p role="alert" className="text-xs font-bold text-error">
          {actionError}
        </p>
      )}

      {!drafts && !error ? (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t("common", CATALOG_KEYS.loading)}
        </p>
      ) : error ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="alert" className="text-xs font-bold text-error">
            {message(error)}
          </p>
          <button type="button" className={quietButton} onClick={() => void load()}>
            <RotateCw size={14} aria-hidden />
            {t("common", CATALOG_KEYS.retry)}
          </button>
        </div>
      ) : drafts!.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-secondary">{t("common", K.empty)}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {drafts!.map((d) => {
            const id = editId(d);
            const value = edits[id] ?? d.draft;
            return (
              <li key={id} className="flex flex-col gap-3 rounded-2xl border border-card-border bg-card-bg p-3 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold text-text-primary">
                    {d.source.fa ?? d.source.en ?? d.key}
                    <span className="ms-2 rounded-full bg-[var(--leaf-bg)] px-2 py-0.5 text-[11px] text-primary">{nameOf(d.lang)}</span>
                  </p>
                  <p className="font-mono text-[10px] text-text-secondary" dir="ltr">
                    {d.key}
                  </p>
                </div>
                <dl className="grid gap-2 text-xs sm:grid-cols-3">
                  <div>
                    <dt className="font-bold text-text-secondary">{t("common", K.source)} · FA</dt>
                    <dd dir="rtl" className="text-text-primary">
                      {d.source.fa ?? t("common", K.none)}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-bold text-text-secondary">{t("common", K.source)} · EN</dt>
                    <dd dir="ltr" className="text-text-primary">
                      {d.source.en ?? t("common", K.none)}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-bold text-text-secondary">{t("common", K.current)}</dt>
                    <dd dir={dirOf(d.lang)} className="text-text-primary">
                      {d.published ?? t("common", K.none)}
                    </dd>
                  </div>
                </dl>
                <label className="flex flex-col gap-1 text-xs font-bold text-text-secondary">
                  {t("common", K.draft)}
                  <textarea
                    className={input}
                    dir={dirOf(d.lang)}
                    rows={2}
                    maxLength={DESCRIPTION_MAX}
                    value={value}
                    onChange={(e) => setEdits((all) => ({ ...all, [id]: e.target.value }))}
                  />
                </label>
                <div className="flex justify-end">
                  <button type="button" className={primaryButton} disabled={busy || value.trim() === ""} onClick={() => void publish([d])}>
                    <Send size={14} aria-hidden />
                    {t("common", value !== d.draft ? K.publishEdited : K.publish)}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
