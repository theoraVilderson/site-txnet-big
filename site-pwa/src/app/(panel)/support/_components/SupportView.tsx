"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Headphones, Plus, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { panelSupportThreadPath } from "@/lib/routes";
import {
  SUPPORT_BODY_MAX,
  supportApi,
  type SupportAvailability,
  type SupportCategory,
  type SupportConversation,
} from "@/lib/support-api";
import { formatInstant } from "../../_lib/datetime";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { Alert, input, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";
import { STATUS_KEYS, SUPPORT_KEYS as K } from "../_lib/support";
import { SupportGuideSuggestions } from "./SupportGuideSuggestions";
import { PageHeader } from "../../_components/kit/PageHeader";

/**
 * The user's support (F-033-o): their conversations, newest activity first,
 * and a new one. support-service decides everything — whose threads, the
 * status, live or async; this page lists, opens and links.
 */
export function SupportView() {
  const { lang, t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const router = useRouter();

  const [items, setItems] = useState<SupportConversation[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const [availability, setAvailability] = useState<SupportAvailability | null>(null);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    let alive = true;
    supportApi
      .list()
      .then((page) => {
        if (!alive) return;
        setItems(page.items);
        setNextBefore(page.nextBefore);
        setError(null);
      })
      .catch((e) => alive && setError(e));
    // The wait notice is a courtesy: a failed read shows none, never an error.
    supportApi
      .availability()
      .then((a) => alive && setAvailability(a))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [asked]);

  async function more() {
    if (!nextBefore) return;
    try {
      const page = await supportApi.list(nextBefore);
      setItems((held) => [...(held ?? []), ...page.items.filter((c) => !held?.some((h) => h.id === c.id))]);
      setNextBefore(page.nextBefore);
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <PageHeader
        icon={Headphones}
        title={t("common", K.title)}
        subtitle={t("common", K.subtitle)}
        actions={
          <>
            {!composing && (
              <button type="button" className={primaryButton} onClick={() => setComposing(true)}>
                <Plus size={14} aria-hidden />
                {t("common", K.newConversation)}
              </button>
            )}
          </>
        }
      />

      {availability && <AvailabilityNotice availability={availability} />}

      {composing && (
        <NewConversation
          onCancel={() => setComposing(false)}
          onOpened={(c) => router.push(panelSupportThreadPath(c.id))}
        />
      )}

      {error && !items ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert>{errorMessage(error)}</Alert>
          <button type="button" className={quietButton} onClick={reload}>
            <RotateCw size={12} aria-hidden />
            {t("common", K.retry)}
          </button>
        </div>
      ) : items === null ? (
        <TableSkeleton rows={4} columns={2} withPagination={false} />
      ) : items.length === 0 ? (
        <p className="rounded-2xl border border-card-border bg-card-bg p-6 text-sm text-text-secondary">{t("common", K.empty)}</p>
      ) : (
        <>
          <ul className="divide-y divide-card-border overflow-hidden rounded-2xl border border-card-border bg-card-bg">
            {items.map((c) => (
              <li key={c.id}>
                <Link href={panelSupportThreadPath(c.id)} className="flex flex-wrap items-center justify-between gap-2 p-4 hover:bg-bg-inner">
                  <div className="min-w-0">
                    <p dir="auto" className={`truncate text-sm text-text-primary ${c.unread > 0 ? "font-bold" : ""}`}>
                      {c.subject}
                    </p>
                    <p className="mt-0.5 text-xs text-text-secondary">
                      {t("common", K.lastActivity, { time: formatInstant(c.lastMessageAt, lang) ?? "" })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {c.unread > 0 && (
                      <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-on-accent">{t("common", K.unread, { n: c.unread })}</span>
                    )}
                    <StatusPill status={c.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {nextBefore && (
            <button type="button" className={quietButton} onClick={more}>
              {t("common", K.more)}
            </button>
          )}
          {error !== null && <Alert>{errorMessage(error)}</Alert>}
        </>
      )}
    </div>
  );
}

export function StatusPill({ status }: { status: SupportConversation["status"] }) {
  const { t } = useLocale();
  const tone = status === "pending_user" ? "bg-primary/10 text-primary" : "bg-bg-inner text-text-secondary";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${tone}`}>{t("common", STATUS_KEYS[status] ?? K.status.open)}</span>;
}

/** Live now, or when an answer can be expected (F-033-g). */
export function AvailabilityNotice({ availability }: { availability: SupportAvailability }) {
  const { lang, t } = useLocale();
  const text = availability.live
    ? t("common", K.availability.live)
    : availability.nextOpenAt
      ? t("common", K.availability.offlineNext, { time: formatInstant(availability.nextOpenAt, lang) ?? "" })
      : t("common", K.availability.offline);
  return (
    <p className="flex items-center gap-2 rounded-xl border border-card-border bg-card-bg px-4 py-3 text-xs text-text-secondary">
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${availability.live ? "bg-success" : "bg-text-secondary/40"}`} aria-hidden />
      {text}
    </p>
  );
}

function NewConversation({ onCancel, onOpened }: { onCancel: () => void; onOpened: (c: SupportConversation) => void }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [categories, setCategories] = useState<SupportCategory[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    supportApi
      .categories()
      .then(setCategories)
      .catch(() => undefined);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setFailure(null);
    try {
      onOpened(await supportApi.open({ body, subject: subject.trim() || undefined, categoryId: categoryId || undefined }));
    } catch (err) {
      setFailure(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
      <h2 className="text-base font-bold text-text-primary">{t("common", K.form.title)}</h2>
      {categories.length > 0 && (
        <label className="block text-xs font-bold text-text-primary">
          {t("common", K.form.category)}
          <select className={`${input} mt-1`} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">{t("common", K.form.categoryNone)}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block text-xs font-bold text-text-primary">
        {t("common", K.form.subject)}
        <input dir="auto" className={`${input} mt-1`} value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} />
        <span className="mt-1 block font-normal text-text-secondary">{t("common", K.form.subjectHint)}</span>
      </label>
      <label className="block text-xs font-bold text-text-primary">
        {t("common", K.form.body)}
        <textarea dir="auto" required rows={5} className={`${input} mt-1`} value={body} maxLength={SUPPORT_BODY_MAX} onChange={(e) => setBody(e.target.value)} />
      </label>
      {/* F-414-k: guides that may already answer it — offered, never in the way of sending. */}
      <SupportGuideSuggestions subject={subject} body={body} />
      {failure && <Alert>{failure}</Alert>}
      <div className="flex items-center gap-2">
        <button type="submit" className={primaryButton} disabled={busy || !body.trim()}>
          {t("common", K.form.submit)}
        </button>
        <button type="button" className={quietButton} onClick={onCancel} disabled={busy}>
          {t("common", K.form.cancel)}
        </button>
      </div>
    </form>
  );
}
