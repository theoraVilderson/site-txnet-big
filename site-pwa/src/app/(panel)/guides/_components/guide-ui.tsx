"use client";

import { useState, type ReactNode } from "react";
import { AlertTriangle, Info, Lightbulb, OctagonAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { guideFileUrl, type CalloutTone, type GuideBlock, type GuideState } from "@/lib/guide-api";
import { Alert } from "../../catalog/_components/catalog-ui";
import { GUIDE_KEYS as K, STATE_KEYS, refusalKey } from "../_lib/guides";

/** tenant-service's refusal in its own sentence, else the generic answer. */
export function useGuideMessage() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = refusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}

export type Note = { ok: boolean; text: string } | null;

/** Run one act, then say `done` or the refusal; `busy` while it runs. */
export function useAct() {
  const message = useGuideMessage();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  async function act<T>(work: () => Promise<T>, done?: string): Promise<T | undefined> {
    setBusy(true);
    setNote(null);
    try {
      const out = await work();
      if (done) setNote({ ok: true, text: done });
      return out;
    } catch (e) {
      setNote({ ok: false, text: message(e) });
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, note, setNote, act };
}

export function NoteLine({ note }: { note: Note }) {
  if (!note) return null;
  return note.ok ? <p className="text-xs font-bold text-primary">{note.text}</p> : <Alert>{note.text}</Alert>;
}

const STATE_TONE: Record<GuideState, string> = {
  published: "bg-leaf-bg text-primary",
  draft: "bg-bg-inner text-text-secondary",
  archived: "bg-bg-inner text-text-secondary line-through",
};

export function Badge({ children, className = "bg-bg-inner text-text-secondary" }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold ${className}`}>{children}</span>;
}

export function StateBadge({ state }: { state: GuideState }) {
  const { t } = useLocale();
  return <Badge className={STATE_TONE[state]}>{t("common", STATE_KEYS[state])}</Badge>;
}

const TONE: Record<CalloutTone, { icon: typeof Info; box: string }> = {
  info: { icon: Info, box: "border-card-border bg-bg-inner" },
  tip: { icon: Lightbulb, box: "border-primary bg-leaf-bg" },
  warning: { icon: AlertTriangle, box: "border-gold bg-gold-bg" },
  danger: { icon: OctagonAlert, box: "border-error-border bg-error-bg" },
};

/**
 * A guide's blocks as a reader sees them — the preview and the read-only view.
 * Text is shown as written, line breaks kept; Markdown is rendered where guides
 * are shown to users (F-414-e). Strings are data: React escapes them.
 */
export function GuideBlocks({ blocks, dir }: { blocks: readonly GuideBlock[]; dir?: string }) {
  const { t } = useLocale();
  return (
    <div dir={dir} className="flex flex-col gap-4 text-sm leading-7 text-text-primary">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "text":
            return (
              <p key={i} className="whitespace-pre-wrap">
                {b.text}
              </p>
            );
          case "image":
            return (
              <figure key={i} className="flex flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- a stored file on this Host, sized by its author */}
                <img src={guideFileUrl(b.file)} alt={b.alt} className="max-h-96 rounded-xl border border-card-border object-contain" />
                {b.caption && <figcaption className="text-xs text-text-secondary">{b.caption}</figcaption>}
              </figure>
            );
          case "video":
            return (
              <figure key={i} className="flex flex-col gap-1">
                <video src={guideFileUrl(b.file)} poster={guideFileUrl(b.poster)} controls preload="none" className="max-h-96 rounded-xl" />
                {b.caption && <figcaption className="text-xs text-text-secondary">{b.caption}</figcaption>}
              </figure>
            );
          case "steps":
            return (
              <ol key={i} className="flex list-decimal flex-col gap-3 ps-5">
                {b.items.map((it, j) => (
                  <li key={j} className="flex flex-col gap-2">
                    <span className="whitespace-pre-wrap">{it.text}</span>
                    {it.image && (
                      // eslint-disable-next-line @next/next/no-img-element -- as above
                      <img src={guideFileUrl(it.image)} alt="" className="max-h-72 rounded-xl border border-card-border object-contain" />
                    )}
                  </li>
                ))}
              </ol>
            );
          case "callout": {
            const { icon: Icon, box } = TONE[b.tone];
            return (
              <aside key={i} className={`flex gap-3 rounded-2xl border p-3 ${box}`}>
                <Icon size={18} className="mt-1 shrink-0" aria-label={t("common", K.tone[b.tone])} />
                <div className="flex flex-col gap-1">
                  {b.title && <strong className="text-sm">{b.title}</strong>}
                  <span className="whitespace-pre-wrap">{b.text}</span>
                </div>
              </aside>
            );
          }
        }
      })}
    </div>
  );
}
