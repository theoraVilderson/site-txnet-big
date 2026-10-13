"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowLeft, ArrowUp, Plus, RotateCw, Trash2, Upload } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import {
  guideApi,
  guideFileUrl,
  guideVideoUrl,
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
import { useRowKeys } from "../../_hooks/useRowKeys";
import { moveRow } from "../../_lib/rows";
import { Select } from "../../_components/kit/Select";
import { Field, useDirOf } from "../../catalog/_components/catalog-ui";
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
  placementError,
  textsBody,
  textsForm,
  validateTexts,
  type EditableBlockType,
} from "../_lib/guides";
import { GuideBlocks } from "../../_components/guide/GuideBlocks";
import { Badge, NoteLine, StateBadge, useAct, useGuideMessage } from "./guide-ui";
import { PageHeader } from "../../_components/kit/PageHeader";
import { Alert, Button, buttonClass, IconButton, Input, Tabs, Textarea } from "../../_components/kit";

type Tab = "texts" | "placements" | "preview";
const TABS: readonly Tab[] = ["texts", "placements", "preview"];

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
            <Alert tone="error">{message(error)}</Alert>
            <Button variant="quiet" size="sm" onClick={reload} icon={<RotateCw size={12} aria-hidden />}>
              {t("common", K.retry)}
            </Button>
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
      <PageHeader
        tail={guide.key}
        title={
          <span dir="ltr" className="font-mono">
            {guide.key}
          </span>
        }
        actions={
          <>
            <Badge>{t("common", KIND_KEYS[guide.kind])}</Badge>
            <StateBadge state={guide.state} />
            {guide.hasDraft && guide.state !== "draft" && <Badge className="bg-gold-bg text-text-primary">{t("common", K.hasDraft)}</Badge>}
          </>
        }
      />

      {guide.readOnly ? (
        <ReadOnly guide={guide} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" disabled={busy || !valid || (!dirty && !guide.hasDraft)} onClick={publish}>
              {t("common", K.publish)}
            </Button>
            <Button variant="quiet" size="sm" className="border border-card-border px-3 py-2" disabled={busy || !dirty || !valid} onClick={save}>
              {t("common", K.saveDraft)}
            </Button>
            {guide.hasDraft && guide.state !== "draft" && (
              <Button variant="quiet" size="sm" disabled={busy} onClick={() => setConfirming("discard")}>
                {t("common", K.discardDraft)}
              </Button>
            )}
            {guide.state === "archived" ? (
              <Button variant="quiet" size="sm" disabled={busy} onClick={() => run(() => guideApi.restore(id))}>
                {t("common", K.restore)}
              </Button>
            ) : (
              <Button variant="quiet" size="sm" disabled={busy} onClick={() => run(() => guideApi.archive(id))}>
                {t("common", K.archive)}
              </Button>
            )}
            <Button variant="quiet" size="sm" className="ms-auto text-error" disabled={busy} onClick={() => setConfirming("delete")} icon={<Trash2 size={12} aria-hidden />}>
              {t("common", K.delete)}
            </Button>
          </div>
          {dirty && <p className="text-xs text-text-secondary">{t("common", K.unsaved)}</p>}
          {confirming && (
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-card-border bg-bg-inner p-3">
              <p className="text-xs text-text-primary">{t("common", confirming === "delete" ? K.deleteConfirm : K.discardConfirm)}</p>
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setConfirming(null);
                  if (confirming === "delete") void remove();
                  else void run(() => guideApi.discardDraft(id));
                }}
              >
                {t("common", confirming === "delete" ? K.delete : K.discardDraft)}
              </Button>
              <Button variant="quiet" size="sm" onClick={() => setConfirming(null)}>
                {t("common", K.cancel)}
              </Button>
            </div>
          )}
          <NoteLine note={note} />

          <Tabs<Tab> ariaLabel={t("common", K.title)} variant="pills" value={tab} onChange={setTab} tabs={TABS.map((v) => ({ value: v, label: t("common", K.tabs[v]) }))} />

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
    <Link href={PANEL_GUIDES} className={buttonClass({ variant: "quiet", size: "sm" })}>
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
      <Button
        variant="primary"
        size="sm"
        disabled={busy}
        onClick={async () => {
          const made = await act(() => guideApi.override(guide.key));
          if (made) router.push(`${PANEL_GUIDES}/${encodeURIComponent(made.id)}`);
        }}
      >
        {t("common", K.override)}
      </Button>
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
  const blockKeys = useRowKeys(text.blocks);

  return (
    <div className="space-y-4">
      <Tabs
        ariaLabel={t("common", K.tabs.texts)}
        variant="pills"
        value={lang}
        onChange={setLang}
        tabs={GUIDE_LANGS.map((l) => ({
          value: l,
          label: t("common", K.language[l]),
          // A language with a refused field is marked, so the error is found from any tab.
          badge: Object.keys(errors).some((k) => k.startsWith(`${l}.`)) ? <span className="text-error">•</span> : undefined,
        }))}
      />
      {errors["texts"] && <Alert tone="error">{t("common", errors["texts"])}</Alert>}

      <Field label={t("common", K.titleLabel)} error={err("title")}>
        <Input dir={dirOf(lang)} value={text.title} maxLength={120} onChange={(e) => set({ ...text, title: e.target.value })} />
      </Field>

      {err("blocks") && <Alert tone="error">{t("common", err("blocks"))}</Alert>}
      <ol className="space-y-3">
        {text.blocks.map((block, i) => (
          <li key={blockKeys[i]} className="space-y-2 rounded-2xl border border-card-border bg-card-bg p-3">
            <div className="flex flex-wrap items-center gap-1">
              <Badge>{t("common", K.block[block.type])}</Badge>
              <div className="ms-auto flex gap-1">
                <IconButton size="sm" aria-label={t("common", K.moveUp)} onClick={() => setBlocks(moveRow(text.blocks, i, -1))} icon={<ArrowUp size={12} aria-hidden />} />
                <IconButton size="sm" aria-label={t("common", K.moveDown)} onClick={() => setBlocks(moveRow(text.blocks, i, 1))} icon={<ArrowDown size={12} aria-hidden />} />
                <IconButton size="sm" className="text-error" aria-label={t("common", K.removeBlock)} onClick={() => setBlocks(text.blocks.filter((_, j) => j !== i))} icon={<Trash2 size={12} aria-hidden />} />
              </div>
            </div>
            <BlockEditor
              guideId={guideId}
              block={block}
              dir={dirOf(lang)}
              onChange={(b) => setBlocks(text.blocks.map((x, j) => (j === i ? b : x)))}
            />
            {err(`blocks.${i}`) && <Alert tone="error">{t("common", err(`blocks.${i}`))}</Alert>}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-text-secondary">{t("common", K.addBlock)}</span>
        {EDITABLE_BLOCKS.map((type: EditableBlockType) => (
          <Button variant="quiet" size="sm" key={type} className="border border-card-border" onClick={() => setBlocks([...text.blocks, emptyBlock(type)])} icon={<Plus size={12} aria-hidden />}>
            {t("common", K.block[type])}
          </Button>
        ))}
      </div>
    </div>
  );
}

function BlockEditor({ guideId, block, dir, onChange }: { guideId: string; block: GuideBlock; dir: string; onChange: (b: GuideBlock) => void }) {
  const { t } = useLocale();
  const itemKeys = useRowKeys(block.type === "steps" ? block.items : []);
  switch (block.type) {
    case "text":
      return (
        <Field label={t("common", K.block.text)} hint={t("common", K.textHint)}>
          <Textarea className="min-h-28" dir={dir} value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} />
        </Field>
      );
    case "image":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <ImagePicker guideId={guideId} value={block.file} onChange={(file) => onChange({ ...block, file })} />
          <div className="flex flex-col gap-2">
            <Field label={t("common", K.imageAlt)}>
              <Input dir={dir} maxLength={200} value={block.alt} onChange={(e) => onChange({ ...block, alt: e.target.value })} />
            </Field>
            <Field label={t("common", K.caption)}>
              <Input dir={dir} maxLength={300} value={block.caption ?? ""} onChange={(e) => onChange({ ...block, caption: e.target.value })} />
            </Field>
          </div>
        </div>
      );
    case "video":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <VideoPicker guideId={guideId} value={block.file} onChange={(file) => onChange({ ...block, file })} />
          <div className="flex flex-col gap-2">
            <ImagePicker guideId={guideId} label={t("common", K.posterUpload)} value={block.poster} onChange={(poster) => onChange({ ...block, poster })} />
            <Field label={t("common", K.caption)}>
              <Input dir={dir} maxLength={300} value={block.caption ?? ""} onChange={(e) => onChange({ ...block, caption: e.target.value })} />
            </Field>
          </div>
        </div>
      );
    case "steps":
      return (
        <div className="space-y-3">
          {block.items.map((item, j) => (
            <div key={itemKeys[j]} className="grid gap-2 rounded-xl bg-bg-inner p-2 sm:grid-cols-[1fr_12rem]">
              <Field label={t("common", K.stepText, { n: String(j + 1) })}>
                <Textarea
                  className="min-h-16"
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
                <Button
                  variant="quiet"
                  size="sm"
                  className="text-error"
                  disabled={block.items.length === 1}
                  onClick={() => onChange({ ...block, items: block.items.filter((_, k) => k !== j) })}
                  icon={<Trash2 size={12} aria-hidden />}
                >
                  {t("common", K.removeStep)}
                </Button>
              </div>
            </div>
          ))}
          <Button variant="quiet" size="sm" disabled={block.items.length >= 30} onClick={() => onChange({ ...block, items: [...block.items, { text: "" }] })} icon={<Plus size={12} aria-hidden />}>
            {t("common", K.stepAdd)}
          </Button>
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
            <Input dir={dir} maxLength={120} value={block.title ?? ""} onChange={(e) => onChange({ ...block, title: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label={t("common", K.block.text)}>
              <Textarea className="min-h-20" dir={dir} value={block.text} onChange={(e) => onChange({ ...block, text: e.target.value })} />
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
      <label className={buttonClass({ variant: "quiet", size: "sm", className: "cursor-pointer border border-card-border" })}>
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

/** A video upload (F-414-i): MP4 or WebM, played from the media server once stored. */
function VideoPicker({ guideId, value, onChange }: { guideId: string; value: string; onChange: (key: string) => void }) {
  const { t } = useLocale();
  const { busy, note, act } = useAct();
  return (
    <div className="flex flex-col gap-2">
      {value && <video src={guideVideoUrl(value)} controls playsInline preload="metadata" className="max-h-48 w-full rounded-xl bg-black" />}
      <label className={buttonClass({ variant: "quiet", size: "sm", className: "cursor-pointer border border-card-border" })}>
        <Upload size={12} aria-hidden />
        {busy ? t("common", K.uploading) : t("common", K.videoUpload)}
        <input
          type="file"
          accept="video/mp4,video/webm"
          className="sr-only"
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            const up = await act(() => guideApi.uploadVideo(guideId, file));
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
  const rowKeys = useRowKeys(rows);

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-secondary">{t("common", K.placementsHint)}</p>
      {rows.length === 0 && <p className="text-xs text-text-secondary">{t("common", K.placementsEmpty)}</p>}
      {rows.map((p, i) => {
        const slot = GUIDE_SLOTS[p.targetKind];
        return (
          <div key={rowKeys[i]} className="grid items-end gap-2 rounded-2xl border border-card-border bg-card-bg p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
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
                <Input className="font-mono" dir="ltr" value={p.targetRef} maxLength={64} onChange={(e) => set(i, { ...p, targetRef: e.target.value.trim() })} />
              )}
            </Field>
            <Field label={t("common", K.surfaceLabel)}>
              <Select
                value={p.surface}
                onChange={(v) => set(i, { ...p, surface: v as GuideSurface })}
                options={slot.surfaces.map((s) => ({ value: s, label: t("common", K.surface[s]) }))}
              />
            </Field>
            <IconButton size="sm" className="text-error" aria-label={t("common", K.removeBlock)} onClick={() => setRows(rows.filter((_, j) => j !== i))} icon={<Trash2 size={14} aria-hidden />} />
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="quiet" size="sm" disabled={rows.length >= 50} onClick={() => setRows([...rows, emptyPlacement("os")])} icon={<Plus size={12} aria-hidden />}>
          {t("common", K.placementAdd)}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || errors.some(Boolean)}
          onClick={async () => {
            const g = await act(() => guideApi.setPlacements(guide.id, rows), t("common", K.saved));
            if (g) onSaved(g);
          }}
        >
          {t("common", K.savePlacements)}
        </Button>
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
      <Tabs ariaLabel={t("common", K.tabs.preview)} variant="pills" value={lang} onChange={setLang} tabs={GUIDE_LANGS.map((l) => ({ value: l, label: t("common", K.language[l]) }))} />
      {dirty && <p className="text-xs text-text-secondary">{t("common", K.unsaved)}</p>}
      {error ? (
        <Alert tone="error">{message(error)}</Alert>
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
