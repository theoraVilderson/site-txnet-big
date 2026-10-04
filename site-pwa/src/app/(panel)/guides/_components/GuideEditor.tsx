"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowLeft, ArrowUp, Plus, RotateCw, Trash2, Upload } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import {
  guideApi,
  guideFileUrl,
  type GuideBlock,
  type GuideDetail,
  type GuideLang,
  type GuidePlacement,
  type GuidePreview,
  type GuideSurface,
  type GuideTargetKind,
  type GuideText,
} from "@/lib/guide-api";
import { PANEL_GUIDES } from "@/lib/routes";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { Select } from "../../_components/kit/Select";
import { Alert, Field, input, primaryButton, quietButton, useDirOf } from "../../catalog/_components/catalog-ui";
import {
  CALLOUT_TONES,
  EDITABLE_BLOCKS,
  GUIDE_KEYS as K,
  GUIDE_LANGS,
  GUIDE_SLOTS,
  GUIDE_TARGET_KINDS,
  KIND_KEYS,
  emptyBlock,
  emptyPlacement,
  moveBlock,
  placementError,
  textsBody,
  textsForm,
  validateTexts,
  type EditableBlockType,
} from "../_lib/guides";
import { GuideBlocks } from "../../_components/guide/GuideBlocks";
import { Badge, NoteLine, StateBadge, useAct, useGuideMessage } from "./guide-ui";

type Tab = "texts" | "placements" | "preview";
const TABS: readonly Tab[] = ["texts", "placements", "preview"];
const tabButton = (on: boolean) => (on ? primaryButton : `${quietButton} border border-card-border px-3 py-2`);

/**
 * `/guides/[id]` (F-414-d): one guide. Texts are edited as a draft — saving
 * never reaches users; **publish** does (ADR-0117 point 1). Placements apply at
 * once. A platform guide seen by a reseller is read-only here.
 */
export function GuideEditor({ id }: { id: string }) {
  const { t } = useLocale();
  const message = useGuideMessage();
  const router = useRouter();
  const [guide, setGuide] = useState<GuideDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const [tab, setTab] = useState<Tab>("texts");
  const [form, setForm] = useState<GuideText[]>([]);
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState<"delete" | "discard" | null>(null);
  const { busy, note, act } = useAct();

  const apply = useCallback((g: GuideDetail) => {
    setGuide(g);
    setForm(textsForm(g.draft.length > 0 ? g.draft : g.published));
    setDirty(false);
  }, []);

  useEffect(() => {
    let alive = true;
    guideApi
      .get(id)
      .then((g) => alive && (apply(g), setError(null)))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [id, asked, apply]);

  if (!guide) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-4 p-4 md:p-8">
        <BackLink />
        {error ? (
          <div className="flex flex-wrap items-center gap-3">
            <Alert>{message(error)}</Alert>
            <button type="button" className={quietButton} onClick={reload}>
              <RotateCw size={12} aria-hidden />
              {t("common", K.retry)}
            </button>
          </div>
        ) : (
          <TableSkeleton rows={5} columns={2} withPagination={false} />
        )}
      </div>
    );
  }

  const errors = validateTexts(form);
  const valid = Object.keys(errors).length === 0;

  async function save(): Promise<GuideDetail | undefined> {
    const g = await act(() => guideApi.saveDraft(id, textsBody(form)), t("common", K.saved));
    if (g) apply(g);
    return g;
  }

  async function publish() {
    const g = await act(async () => {
      if (dirty) await guideApi.saveDraft(id, textsBody(form));
      return guideApi.publish(id);
    }, t("common", K.publishedNote));
    if (g) apply(g);
  }

  async function run(work: () => Promise<GuideDetail>) {
    const g = await act(work, t("common", K.saved));
    if (g) apply(g);
  }

  async function remove() {
    const done = await act(() => guideApi.remove(id).then(() => true));
    if (done) router.push(PANEL_GUIDES);
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-4 md:p-8">
      <BackLink />
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="font-mono text-xl font-bold text-text-primary md:text-2xl">{guide.key}</h1>
        <Badge>{t("common", KIND_KEYS[guide.kind])}</Badge>
        <StateBadge state={guide.state} />
        {guide.hasDraft && guide.state !== "draft" && <Badge className="bg-gold-bg text-text-primary">{t("common", K.hasDraft)}</Badge>}
      </header>

      {guide.readOnly ? (
        <ReadOnly guide={guide} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={primaryButton} disabled={busy || !valid || (!dirty && !guide.hasDraft)} onClick={publish}>
              {t("common", K.publish)}
            </button>
            <button type="button" className={`${quietButton} border border-card-border px-3 py-2`} disabled={busy || !dirty || !valid} onClick={save}>
              {t("common", K.saveDraft)}
            </button>
            {guide.hasDraft && guide.state !== "draft" && (
              <button type="button" className={quietButton} disabled={busy} onClick={() => setConfirming("discard")}>
                {t("common", K.discardDraft)}
              </button>
            )}
            {guide.state === "archived" ? (
              <button type="button" className={quietButton} disabled={busy} onClick={() => run(() => guideApi.restore(id))}>
                {t("common", K.restore)}
              </button>
            ) : (
              <button type="button" className={quietButton} disabled={busy} onClick={() => run(() => guideApi.archive(id))}>
                {t("common", K.archive)}
              </button>
            )}
            <button type="button" className={`${quietButton} ms-auto text-error`} disabled={busy} onClick={() => setConfirming("delete")}>
              <Trash2 size={12} aria-hidden />
              {t("common", K.delete)}
            </button>
          </div>
          {dirty && <p className="text-xs text-text-secondary">{t("common", K.unsaved)}</p>}
          {confirming && (
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-card-border bg-bg-inner p-3">
              <p className="text-xs text-text-primary">{t("common", confirming === "delete" ? K.deleteConfirm : K.discardConfirm)}</p>
              <button
                type="button"
                className={primaryButton}
                disabled={busy}
                onClick={() => {
                  setConfirming(null);
                  if (confirming === "delete") void remove();
                  else void run(() => guideApi.discardDraft(id));
                }}
              >
                {t("common", confirming === "delete" ? K.delete : K.discardDraft)}
              </button>
              <button type="button" className={quietButton} onClick={() => setConfirming(null)}>
                {t("common", K.cancel)}
              </button>
            </div>
          )}
          <NoteLine note={note} />

          <div role="tablist" className="flex flex-wrap gap-2">
            {TABS.map((v) => (
              <button key={v} type="button" role="tab" aria-selected={tab === v} onClick={() => setTab(v)} className={tabButton(tab === v)}>
                {t("common", K.tabs[v])}
              </button>
            ))}
          </div>

          {tab === "texts" && (
            <TextsTab
              guideId={id}
              form={form}
              errors={errors}
              onChange={(next) => {
                setForm(next);
                setDirty(true);
              }}
            />
          )}
          {tab === "placements" && <PlacementsTab guide={guide} onSaved={apply} />}
          {tab === "preview" && <PreviewTab guideId={id} dirty={dirty} />}
        </>
      )}
    </div>
  );
}

function BackLink() {
  const { t } = useLocale();
  return (
    <Link href={PANEL_GUIDES} className={quietButton}>
      <ArrowLeft size={12} aria-hidden className="rtl:rotate-180" />
      {t("common", K.back)}
    </Link>
  );
}

/** A platform guide a reseller inherits: its published text, and the way to make it its own. */
function ReadOnly({ guide }: { guide: GuideDetail }) {
  const { t } = useLocale();
  const dirOf = useDirOf();
  const router = useRouter();
  const { busy, note, act } = useAct();
  return (
    <div className="space-y-4">
      <p className="rounded-2xl border border-card-border bg-bg-inner p-3 text-xs text-text-secondary">{t("common", K.readOnly)}</p>
      <button
        type="button"
        className={primaryButton}
        disabled={busy}
        onClick={async () => {
          const made = await act(() => guideApi.override(guide.key));
          if (made) router.push(`${PANEL_GUIDES}/${encodeURIComponent(made.id)}`);
        }}
      >
        {t("common", K.override)}
      </button>
      <NoteLine note={note} />
      {guide.published.map((text) => (
        <article key={text.lang} className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
          <Badge>{t("common", K.language[text.lang])}</Badge>
          <h2 dir={dirOf(text.lang)} className="text-lg font-bold text-text-primary">
            {text.title}
          </h2>
          <GuideBlocks blocks={text.blocks} dir={dirOf(text.lang)} />
        </article>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ texts

function TextsTab({ guideId, form, errors, onChange }: { guideId: string; form: GuideText[]; errors: Record<string, string>; onChange: (f: GuideText[]) => void }) {
  const { t } = useLocale();
  const dirOf = useDirOf();
  const [lang, setLang] = useState<GuideLang>("fa");
  const text = form.find((x) => x.lang === lang) ?? { lang, title: "", blocks: [] };
  const set = (next: GuideText) => onChange(form.map((x) => (x.lang === lang ? next : x)));
  const setBlocks = (blocks: GuideBlock[]) => set({ ...text, blocks });
  const err = (f: string) => errors[`${lang}.${f}`];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {GUIDE_LANGS.map((l) => {
          const has = Object.keys(errors).some((k) => k.startsWith(`${l}.`));
          return (
            <button key={l} type="button" onClick={() => setLang(l)} className={tabButton(lang === l)}>
              {t("common", K.language[l])}
              {has && <span className="ms-1 text-error">•</span>}
            </button>
          );
        })}
      </div>
      {errors["texts"] && <Alert>{t("common", errors["texts"])}</Alert>}

      <Field label={t("common", K.titleLabel)} error={err("title")}>
        <input className={input} dir={dirOf(lang)} value={text.title} maxLength={120} onChange={(e) => set({ ...text, title: e.target.value })} />
      </Field>

      {err("blocks") && <Alert>{t("common", err("blocks"))}</Alert>}
      <ol className="space-y-3">
        {text.blocks.map((block, i) => (
          <li key={i} className="space-y-2 rounded-2xl border border-card-border bg-card-bg p-3">
            <div className="flex flex-wrap items-center gap-1">
              <Badge>{t("common", K.block[block.type])}</Badge>
              <div className="ms-auto flex gap-1">
                <button type="button" className={quietButton} aria-label={t("common", K.moveUp)} onClick={() => setBlocks(moveBlock(text.blocks, i, -1))}>
                  <ArrowUp size={12} aria-hidden />
                </button>
                <button type="button" className={quietButton} aria-label={t("common", K.moveDown)} onClick={() => setBlocks(moveBlock(text.blocks, i, 1))}>
                  <ArrowDown size={12} aria-hidden />
                </button>
                <button
                  type="button"
                  className={`${quietButton} text-error`}
                  aria-label={t("common", K.removeBlock)}
                  onClick={() => setBlocks(text.blocks.filter((_, j) => j !== i))}
                >
                  <Trash2 size={12} aria-hidden />
                </button>
              </div>
            </div>
            <BlockEditor
              guideId={guideId}
              block={block}
              dir={dirOf(lang)}
              onChange={(b) => setBlocks(text.blocks.map((x, j) => (j === i ? b : x)))}
            />
            {err(`blocks.${i}`) && <Alert>{t("common", err(`blocks.${i}`))}</Alert>}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-text-secondary">{t("common", K.addBlock)}</span>
        {EDITABLE_BLOCKS.map((type: EditableBlockType) => (
          <button key={type} type="button" className={`${quietButton} border border-card-border`} onClick={() => setBlocks([...text.blocks, emptyBlock(type)])}>
            <Plus size={12} aria-hidden />
            {t("common", K.block[type])}
          </button>
        ))}
      </div>
    </div>
  );
}

function BlockEditor({ guideId, block, dir, onChange }: { guideId: string; block: GuideBlock; dir: string; onChange: (b: GuideBlock) => void }) {
  const { t } = useLocale();
  switch (block.type) {
    case "text":
      return (
        <Field label={t("common", K.block.text)} hint={t("common", K.textHint)}>
          <textarea className={`${input} min-h-28`} dir={dir} value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} />
        </Field>
      );
    case "image":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <ImagePicker guideId={guideId} value={block.file} onChange={(file) => onChange({ ...block, file })} />
          <div className="flex flex-col gap-2">
            <Field label={t("common", K.imageAlt)}>
              <input className={input} dir={dir} maxLength={200} value={block.alt} onChange={(e) => onChange({ ...block, alt: e.target.value })} />
            </Field>
            <Field label={t("common", K.caption)}>
              <input className={input} dir={dir} maxLength={300} value={block.caption ?? ""} onChange={(e) => onChange({ ...block, caption: e.target.value })} />
            </Field>
          </div>
        </div>
      );
    case "video":
      return (
        <div className="space-y-2">
          <p className="text-xs text-text-secondary">{t("common", K.videoLater)}</p>
          <GuideBlocks blocks={[block]} dir={dir} />
        </div>
      );
    case "steps":
      return (
        <div className="space-y-3">
          {block.items.map((item, j) => (
            <div key={j} className="grid gap-2 rounded-xl bg-bg-inner p-2 sm:grid-cols-[1fr_12rem]">
              <Field label={t("common", K.stepText, { n: String(j + 1) })}>
                <textarea
                  className={`${input} min-h-16`}
                  dir={dir}
                  value={item.text}
                  onChange={(e) => onChange({ ...block, items: block.items.map((x, k) => (k === j ? { ...x, text: e.target.value } : x)) })}
                />
              </Field>
              <div className="flex flex-col gap-1">
                <ImagePicker
                  guideId={guideId}
                  label={t("common", K.stepImage)}
                  value={item.image ?? ""}
                  onChange={(image) => onChange({ ...block, items: block.items.map((x, k) => (k === j ? { ...x, image } : x)) })}
                />
                <button
                  type="button"
                  className={`${quietButton} text-error`}
                  disabled={block.items.length === 1}
                  onClick={() => onChange({ ...block, items: block.items.filter((_, k) => k !== j) })}
                >
                  <Trash2 size={12} aria-hidden />
                  {t("common", K.removeStep)}
                </button>
              </div>
            </div>
          ))}
          <button type="button" className={quietButton} disabled={block.items.length >= 30} onClick={() => onChange({ ...block, items: [...block.items, { text: "" }] })}>
            <Plus size={12} aria-hidden />
            {t("common", K.stepAdd)}
          </button>
        </div>
      );
    case "callout":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t("common", K.calloutTone)}>
            <Select
              value={block.tone}
              onChange={(v) => onChange({ ...block, tone: v as typeof block.tone })}
              options={CALLOUT_TONES.map((tone) => ({ value: tone, label: t("common", K.tone[tone]) }))}
            />
          </Field>
          <Field label={t("common", K.calloutTitle)}>
            <input className={input} dir={dir} maxLength={120} value={block.title ?? ""} onChange={(e) => onChange({ ...block, title: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label={t("common", K.block.text)}>
              <textarea className={`${input} min-h-20`} dir={dir} value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} />
            </Field>
          </div>
        </div>
      );
  }
}

/** Uploads to tenant-service and hands back the key; shows the stored image once there is one. */
function ImagePicker({ guideId, value, label, onChange }: { guideId: string; value: string; label?: string; onChange: (key: string) => void }) {
  const { t } = useLocale();
  const { busy, note, act } = useAct();
  return (
    <div className="flex flex-col gap-2">
      {value && (
        // eslint-disable-next-line @next/next/no-img-element -- a stored file on this Host
        <img src={guideFileUrl(value)} alt="" className="max-h-40 rounded-xl border border-card-border object-contain" />
      )}
      <label className={`${quietButton} cursor-pointer border border-card-border`}>
        <Upload size={12} aria-hidden />
        {busy ? t("common", K.uploading) : (label ?? t("common", K.imageUpload))}
        <input
          type="file"
          accept="image/png,image/webp,image/jpeg"
          className="sr-only"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            const up = await act(() => guideApi.upload(guideId, file));
            if (up) onChange(up.key);
          }}
        />
      </label>
      <NoteLine note={note} />
    </div>
  );
}

// ------------------------------------------------------------------ placements

function PlacementsTab({ guide, onSaved }: { guide: GuideDetail; onSaved: (g: GuideDetail) => void }) {
  const { t } = useLocale();
  const [rows, setRows] = useState<GuidePlacement[]>(guide.placements);
  const { busy, note, act } = useAct();
  const errors = rows.map(placementError);
  const set = (i: number, p: GuidePlacement) => setRows(rows.map((r, j) => (j === i ? p : r)));

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-secondary">{t("common", K.placementsHint)}</p>
      {rows.length === 0 && <p className="text-xs text-text-secondary">{t("common", K.placementsEmpty)}</p>}
      {rows.map((p, i) => {
        const slot = GUIDE_SLOTS[p.targetKind];
        return (
          <div key={i} className="grid items-end gap-2 rounded-2xl border border-card-border bg-card-bg p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <Field label={t("common", K.kindLabel)}>
              <Select
                value={p.targetKind}
                onChange={(v) => set(i, emptyPlacement(v as GuideTargetKind))}
                options={GUIDE_TARGET_KINDS.map((k) => ({ value: k, label: t("common", K.targetKind[k]) }))}
              />
            </Field>
            <Field label={t("common", K.targetRef)} hint={slot.refs ? undefined : t("common", K.targetRefHint)} error={errors[i] ?? undefined}>
              {slot.refs ? (
                <Select value={p.targetRef} onChange={(v) => set(i, { ...p, targetRef: v })} options={slot.refs.map((r) => ({ value: r, label: r }))} />
              ) : (
                <input className={`${input} font-mono`} dir="ltr" value={p.targetRef} maxLength={64} onChange={(e) => set(i, { ...p, targetRef: e.target.value.trim() })} />
              )}
            </Field>
            <Field label={t("common", K.surfaceLabel)}>
              <Select
                value={p.surface}
                onChange={(v) => set(i, { ...p, surface: v as GuideSurface })}
                options={slot.surfaces.map((s) => ({ value: s, label: t("common", K.surface[s]) }))}
              />
            </Field>
            <button type="button" className={`${quietButton} text-error`} aria-label={t("common", K.removeBlock)} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              <Trash2 size={14} aria-hidden />
            </button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={quietButton} disabled={rows.length >= 50} onClick={() => setRows([...rows, emptyPlacement("os")])}>
          <Plus size={12} aria-hidden />
          {t("common", K.placementAdd)}
        </button>
        <button
          type="button"
          className={primaryButton}
          disabled={busy || errors.some(Boolean)}
          onClick={async () => {
            const g = await act(() => guideApi.setPlacements(guide.id, rows), t("common", K.saved));
            if (g) onSaved(g);
          }}
        >
          {t("common", K.savePlacements)}
        </button>
        <NoteLine note={note} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ preview

function PreviewTab({ guideId, dirty }: { guideId: string; dirty: boolean }) {
  const { t } = useLocale();
  const dirOf = useDirOf();
  const message = useGuideMessage();
  const [lang, setLang] = useState<GuideLang>("fa");
  // The answer with the language it was asked in: a switch shows the skeleton until its own arrives.
  const [loaded, setLoaded] = useState<{ lang: GuideLang; preview?: GuidePreview; error?: unknown } | null>(null);

  useEffect(() => {
    let alive = true;
    guideApi
      .preview(guideId, lang)
      .then((p) => alive && setLoaded({ lang, preview: p }))
      .catch((e) => alive && setLoaded({ lang, error: e }));
    return () => {
      alive = false;
    };
  }, [guideId, lang]);

  const current = loaded?.lang === lang ? loaded : null;
  const preview = current?.preview ?? null;
  const error = current?.error ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {GUIDE_LANGS.map((l) => (
          <button key={l} type="button" onClick={() => setLang(l)} className={tabButton(lang === l)}>
            {t("common", K.language[l])}
          </button>
        ))}
      </div>
      {dirty && <p className="text-xs text-text-secondary">{t("common", K.unsaved)}</p>}
      {error ? (
        <Alert>{message(error)}</Alert>
      ) : !preview ? (
        <TableSkeleton rows={3} columns={1} withPagination={false} />
      ) : (
        <article className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
          <div className="flex flex-wrap gap-2">
            <Badge>{t("common", K.previewSource[preview.source])}</Badge>
            {preview.lang !== lang && <Badge>{t("common", K.previewEmpty)}</Badge>}
          </div>
          <h2 dir={dirOf(preview.lang)} className="text-lg font-bold text-text-primary">
            {preview.title}
          </h2>
          <GuideBlocks blocks={preview.blocks} dir={dirOf(preview.lang)} />
        </article>
      )}
    </div>
  );
}
