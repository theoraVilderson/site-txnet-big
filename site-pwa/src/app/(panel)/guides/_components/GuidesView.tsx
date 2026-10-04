"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookMarked, Eye, EyeOff, Pencil, Plus, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { guideApi, type GuideKind, type GuideLang, type GuideList } from "@/lib/guide-api";
import { panelGuidePath } from "@/lib/routes";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { Select } from "../../_components/kit/Select";
import { Field, input, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";
import { GUIDE_KEYS as K, GUIDE_KEY_PATTERN, GUIDE_KINDS, GUIDE_LANGS, KIND_KEYS } from "../_lib/guides";
import { Badge, NoteLine, StateBadge, useAct, useGuideMessage } from "./guide-ui";

/**
 * `/guides` (F-414-d): the caller's own guides — the platform's, for the
 * platform owner's admin — and, for a reseller, the platform's it inherits,
 * each to override or hide. Over tenant-service's `/api/guides/settings`.
 */
export function GuidesView() {
  const { t } = useLocale();
  const message = useGuideMessage();
  const [data, setData] = useState<GuideList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const { busy, note, act } = useAct();
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    guideApi
      .list()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [asked]);

  async function override(key: string) {
    const made = await act(() => guideApi.override(key));
    if (made) router.push(panelGuidePath(made.id));
  }

  async function toggleHidden(key: string, hidden: boolean) {
    const done = await act(() => (hidden ? guideApi.unhide(key) : guideApi.hide(key)).then(() => true));
    if (done) reload();
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary md:text-3xl">
          <BookMarked size={22} className="text-primary" aria-hidden />
          {t("common", K.title)}
        </h1>
        <p className="mt-1 text-sm text-text-secondary">{t("common", K.subtitle)}</p>
      </header>

      {!data ? (
        error ? (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="text-xs font-bold text-error">
              {message(error)}
            </p>
            <button type="button" className={quietButton} onClick={reload}>
              <RotateCw size={12} aria-hidden />
              {t("common", K.retry)}
            </button>
          </div>
        ) : (
          <TableSkeleton rows={4} columns={3} withPagination={false} />
        )
      ) : (
        <>
          <NewGuide onCreated={(id) => router.push(panelGuidePath(id))} />
          <NoteLine note={note} />

          <section className="space-y-3">
            <h2 className="text-sm font-bold text-text-primary">{t("common", data.owner === "platform" ? K.ownPlatform : K.ownTenant)}</h2>
            {data.own.length === 0 ? (
              <p className="text-xs text-text-secondary">{t("common", K.empty)}</p>
            ) : (
              <ul className="divide-y divide-card-border rounded-2xl border border-card-border bg-card-bg">
                {data.own.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center gap-2 p-3">
                    <Link href={panelGuidePath(g.id)} className="font-mono text-sm font-bold text-text-primary hover:text-primary">
                      {g.key}
                    </Link>
                    <Badge>{t("common", KIND_KEYS[g.kind])}</Badge>
                    <StateBadge state={g.state} />
                    {g.hasDraft && g.state !== "draft" && <Badge className="bg-gold-bg text-text-primary">{t("common", K.hasDraft)}</Badge>}
                    <span className="text-[11px] text-text-secondary">{g.publishedLangs.map((l) => t("common", K.language[l])).join("، ")}</span>
                    <Link href={panelGuidePath(g.id)} className={`${quietButton} ms-auto`}>
                      <Pencil size={12} aria-hidden />
                      {t("common", K.open)}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {data.owner === "tenant" && (
            <section className="space-y-3">
              <h2 className="text-sm font-bold text-text-primary">{t("common", K.inherited)}</h2>
              <p className="text-xs text-text-secondary">{t("common", K.inheritedHint)}</p>
              {data.inherited.length === 0 ? (
                <p className="text-xs text-text-secondary">{t("common", K.inheritedEmpty)}</p>
              ) : (
                <ul className="divide-y divide-card-border rounded-2xl border border-card-border bg-card-bg">
                  {data.inherited.map((g) => (
                    <li key={g.id} className="flex flex-wrap items-center gap-2 p-3">
                      <span className="text-sm font-bold text-text-primary">{g.title}</span>
                      <span className="font-mono text-[11px] text-text-secondary">{g.key}</span>
                      {g.hidden && <Badge>{t("common", K.hiddenBadge)}</Badge>}
                      {g.overriddenBy && <Badge className="bg-leaf-bg text-primary">{t("common", K.overriddenBadge)}</Badge>}
                      <div className="ms-auto flex flex-wrap gap-1">
                        <Link href={panelGuidePath(g.overriddenBy ?? g.id)} className={quietButton}>
                          <Eye size={12} aria-hidden />
                          {t("common", g.overriddenBy ? K.open : K.view)}
                        </Link>
                        {!g.overriddenBy && (
                          <button type="button" className={quietButton} disabled={busy} onClick={() => override(g.key)}>
                            <Pencil size={12} aria-hidden />
                            {t("common", K.override)}
                          </button>
                        )}
                        <button type="button" className={quietButton} disabled={busy} onClick={() => toggleHidden(g.key, g.hidden)}>
                          {g.hidden ? <Eye size={12} aria-hidden /> : <EyeOff size={12} aria-hidden />}
                          {t("common", g.hidden ? K.unhide : K.hide)}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** Key, kind, a first language's title and paragraph: tenant-service wants one text to make a draft. */
function NewGuide({ onCreated }: { onCreated: (id: string) => void }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [kind, setKind] = useState<GuideKind>("os");
  const [lang, setLang] = useState<GuideLang>("fa");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const { busy, note, act } = useAct();
  const keyError = key && !GUIDE_KEY_PATTERN.test(key) ? K.errors.badKey : undefined;
  const ready = GUIDE_KEY_PATTERN.test(key) && title.trim() !== "" && text.trim() !== "";

  if (!open) {
    return (
      <button type="button" className={primaryButton} onClick={() => setOpen(true)}>
        <Plus size={14} aria-hidden />
        {t("common", K.newGuide)}
      </button>
    );
  }

  async function create() {
    const made = await act(() => guideApi.create({ key, kind, texts: [{ lang, title: title.trim(), blocks: [{ type: "text", text: text.trim() }] }] }));
    if (made) onCreated(made.id);
  }

  return (
    <div className="grid gap-3 rounded-2xl border border-card-border bg-card-bg p-4 sm:grid-cols-2">
      <Field label={t("common", K.key)} hint={t("common", K.keyHint)} error={keyError}>
        <input className={`${input} font-mono`} dir="ltr" value={key} onChange={(e) => setKey(e.target.value.trim())} maxLength={60} />
      </Field>
      <Field label={t("common", K.kindLabel)}>
        <Select value={kind} onChange={(v) => setKind(v as GuideKind)} options={GUIDE_KINDS.map((k) => ({ value: k, label: t("common", KIND_KEYS[k]) }))} />
      </Field>
      <Field label={t("common", K.langLabel)}>
        <Select value={lang} onChange={(v) => setLang(v as GuideLang)} options={GUIDE_LANGS.map((l) => ({ value: l, label: t("common", K.language[l]) }))} />
      </Field>
      <Field label={t("common", K.titleLabel)}>
        <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </Field>
      <div className="sm:col-span-2">
        <Field label={t("common", K.block.text)} hint={t("common", K.textHint)}>
          <textarea className={`${input} min-h-24`} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <button type="button" className={primaryButton} disabled={!ready || busy} onClick={create}>
          {t("common", K.create)}
        </button>
        <button type="button" className={quietButton} onClick={() => setOpen(false)}>
          {t("common", K.cancel)}
        </button>
        <NoteLine note={note} />
      </div>
    </div>
  );
}
