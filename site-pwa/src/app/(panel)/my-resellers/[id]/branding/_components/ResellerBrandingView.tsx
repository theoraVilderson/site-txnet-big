"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Plus, Smartphone } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { authApi } from "@/lib/auth-api";
import { resellerBrandingApi, type LineNamePreview, type ResellerBranding } from "@/lib/tenant-api";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { Field } from "../../../../catalog/_components/catalog-ui";
import {
  BRANDING_KEYS as K,
  LINE_NAME_PLACEHOLDERS,
  LINE_NAME_PLACEHOLDER_KEYS,
  LINE_NAME_PROBLEM_KEYS,
  MAX_LINE_NAME_TEMPLATE_LENGTH,
  brandingRefusalKey,
  insertPlaceholder,
  templateToSend,
} from "../../../_lib/branding";
import { Alert, Button, Input, PageHeader } from "../../../../_components/kit";

/** How long typing rests before the preview is asked for. */
const PREVIEW_DELAY_MS = 300;

/** The refusal's own sentence, else the generic answer for that error. */
function useMessage() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = brandingRefusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}

/**
 * A reseller's brand settings (F-307-k, ADR-0089 rule 4). By the reseller the
 * path names, never the session's tenant (ADR-0064).
 *
 *  - **the panel never builds a name.** The preview is tenant-service's
 *    answer, evaluated by the rule billing and `/sub` use, over a sample
 *    region; so is every problem it names;
 *  - **empty is the default**, sent as `null`: the region alone;
 *  - **no permission is judged here.** A suspended owner reads and is refused
 *    on save, with that refusal's sentence.
 */
export function ResellerBrandingView({ id }: { id: string }) {
  const { t } = useLocale();
  const message = useMessage();

  const [branding, setBranding] = useState<ResellerBranding | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const retry = () => {
    setLoadError(null);
    setAsked((n) => n + 1);
  };

  useEffect(() => {
    let alive = true;
    resellerBrandingApi
      .get(id)
      .then((b) => alive && setBranding(b))
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [id, asked]);

  // The name for the title, when the visitor owns it; staff see the plain title.
  useEffect(() => {
    let alive = true;
    authApi
      .ownedResellers()
      .then((r) => alive && setSlug(r.resellers.find((x) => x.id === id)?.slug ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-8">
      <PageHeader title={slug ? t("common", K.title, { slug }) : t("common", K.titlePlain)} subtitle={t("common", K.subtitle)} />

      {loadError !== null ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-6">
          <Alert tone="error">{message(loadError)}</Alert>
          <Button variant="primary" size="sm" onClick={retry}>
            {t("common", K.reload)}
          </Button>
        </div>
      ) : branding === null ? (
        <TableSkeleton rows={2} columns={1} />
      ) : (
        <LineNameSection id={id} saved={branding.lineNameTemplate} onSaved={setBranding} />
      )}
    </div>
  );
}

function LineNameSection({ id, saved, onSaved }: { id: string; saved: string | null; onSaved: (b: ResellerBranding) => void }) {
  const { t } = useLocale();
  const message = useMessage();
  const L = K.lineName;
  const field = useRef<HTMLInputElement>(null);

  const [typed, setTyped] = useState(saved ?? "");
  // The answer, with the template it answers: a newer template is still being asked.
  const [answered, setAnswered] = useState<{ template: string | null; preview: LineNamePreview | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [justSaved, setJustSaved] = useState(false);

  const template = templateToSend(typed);
  const region = t("common", L.sampleRegion);

  // Asked of the server once typing rests; an answer for an older template is dropped.
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      resellerBrandingApi
        .previewLineName(id, template, region)
        .then((preview) => alive && setAnswered({ template, preview }))
        .catch(() => alive && setAnswered({ template, preview: null }));
    }, PREVIEW_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, template, region]);

  const preview = answered?.preview ?? null;
  const previewing = answered?.template !== template;
  const problem = preview?.problem ?? null;
  const unchanged = template === saved;

  const change = (value: string) => {
    setTyped(value);
    setJustSaved(false);
    setError(null);
  };

  const insert = (placeholder: string) => {
    const el = field.current;
    const next = insertPlaceholder(typed, el?.selectionStart ?? typed.length, placeholder);
    change(next.value);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  };

  const save = async (value: string | null) => {
    setSaving(true);
    setError(null);
    try {
      const b = await resellerBrandingApi.setLineNameTemplate(id, value);
      onSaved(b);
      setTyped(b.lineNameTemplate ?? "");
      setJustSaved(true);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4 rounded-2xl border border-card-border bg-card-bg p-6">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-base font-bold text-text-primary">
          <Smartphone size={18} className="shrink-0 text-primary" aria-hidden />
          {t("common", L.title)}
        </h2>
        <p className="text-sm text-text-secondary">{t("common", L.body)}</p>
      </div>

      <Field label={t("common", L.field)} hint={t("common", L.hint)} error={problem ? LINE_NAME_PROBLEM_KEYS[problem] : undefined}>
        <Input
          ref={field}
          dir="auto"
          value={typed}
          placeholder="{region}"
          maxLength={MAX_LINE_NAME_TEMPLATE_LENGTH * 4}
          onChange={(e) => change(e.target.value)}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
        <span>{t("common", L.insert)}</span>
        {LINE_NAME_PLACEHOLDERS.map((p) => (
          <Button variant="quiet" size="sm" key={p} className="border border-card-border" onClick={() => insert(p)} icon={<Plus size={12} aria-hidden />}>
            {t("common", LINE_NAME_PLACEHOLDER_KEYS[p])}
            <code className="font-mono text-[11px] text-text-secondary" dir="ltr">{`{${p}}`}</code>
          </Button>
        ))}
      </div>

      <div className="space-y-1 rounded-xl border border-card-border bg-bg-inner p-4" aria-live="polite">
        <p className="text-[11px] font-bold text-text-secondary">{t("common", L.preview)}</p>
        {previewing && answered === null ? (
          <Loader2 size={14} className="animate-spin text-text-secondary" aria-hidden />
        ) : problem ? (
          <p className="text-sm text-text-secondary">—</p>
        ) : preview?.name ? (
          <>
            <p className="text-base font-bold text-text-primary" dir="auto">
              {preview.name}
            </p>
            <p className="text-[11px] text-text-secondary">{t("common", L.numbered, { name: preview.name })}</p>
          </>
        ) : (
          <p className="text-sm text-text-secondary">{t("common", L.previewNone)}</p>
        )}
      </div>

      {error !== null && <Alert tone="error">{message(error)}</Alert>}
      {justSaved && (
        <p className="flex items-center gap-1.5 text-xs font-bold text-primary">
          <CheckCircle2 size={14} aria-hidden />
          {t("common", L.saved)}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={unchanged || problem !== null || previewing}
          onClick={() => save(template)}
          loading={saving}
        >
          {t("common", saving ? L.saving : L.save)}
        </Button>
        {saved !== null && (
          <Button variant="quiet" size="sm" disabled={saving} onClick={() => save(null)}>
            {t("common", L.useDefault)}
          </Button>
        )}
      </div>
    </section>
  );
}
