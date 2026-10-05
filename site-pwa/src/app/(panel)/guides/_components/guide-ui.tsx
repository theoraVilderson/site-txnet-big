"use client";

import { useState, type ReactNode } from "react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import type { GuideState } from "@/lib/guide-api";
import { STATE_KEYS, refusalKey } from "../_lib/guides";
import { Alert } from "../../_components/kit";

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
  return note.ok ? <p className="text-xs font-bold text-primary">{note.text}</p> : <Alert tone="error">{note.text}</Alert>;
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
