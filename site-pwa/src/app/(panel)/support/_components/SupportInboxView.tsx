"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Inbox, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { panelSupportInboxThreadPath } from "@/lib/routes";
import { supportAgentApi, type AgentConversation, type InboxView } from "@/lib/support-api";
import { formatInstant } from "../../_lib/datetime";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { Alert, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";
import { AGENT_KEYS as K, INBOX_VIEWS, PRIORITY_KEYS, VIEW_KEYS, slaState } from "../_lib/support-agent";
import { StatusPill } from "./SupportView";
import { usePresence } from "./usePresence";

/**
 * The agent's inbox (F-033-p) over `/api/support/agent/conversations`
 * (F-033-d). support-service orders the queue — urgent first, then the
 * nearest SLA due, then the longest waiting — and RLS keeps it to the
 * caller's tenant; this page shows the four views and links a thread.
 */
export function SupportInboxView() {
  const { lang, t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const { me } = usePanelSession();
  const presence = usePresence();

  const [view, setView] = useState<InboxView>("pending");
  const [items, setItems] = useState<AgentConversation[] | null>(null);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    supportAgentApi
      .inbox(view)
      .then((page) => {
        if (!alive) return;
        setItems(page.items);
        setNextAfter(page.nextAfter);
        setError(null);
        setNow(Date.now());
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [view, asked]);

  // The queue moves without an event per thread (new threads have no channel yet): re-read each minute.
  useEffect(() => {
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [reload]);

  async function more() {
    if (!nextAfter) return;
    try {
      const page = await supportAgentApi.inbox(view, nextAfter);
      setItems((held) => [...(held ?? []), ...page.items.filter((c) => !held?.some((h) => h.id === c.id))]);
      setNextAfter(page.nextAfter);
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-4 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary md:text-3xl">
            <Inbox size={22} className="text-primary" aria-hidden />
            {t("common", K.title)}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">{t("common", K.subtitle)}</p>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-card-border bg-card-bg px-3 py-2 text-xs text-text-secondary">
          <span className={`inline-block h-2 w-2 rounded-full ${presence.online ? "bg-success" : "bg-text-secondary/40"}`} aria-hidden />
          {t("common", presence.online ? K.presence.online : K.presence.away)}
          <button type="button" className={quietButton} onClick={presence.toggle}>
            {t("common", presence.online ? K.presence.goAway : K.presence.goOnline)}
          </button>
        </div>
      </header>

      <div role="tablist" className="flex flex-wrap gap-2">
        {INBOX_VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            onClick={() => {
              setItems(null);
              setView(v);
            }}
            className={view === v ? primaryButton : `${quietButton} border border-card-border px-3 py-2`}
          >
            {t("common", VIEW_KEYS[v])}
          </button>
        ))}
        <button type="button" className={quietButton} onClick={reload} aria-label={t("common", K.retry)}>
          <RotateCw size={12} aria-hidden />
        </button>
      </div>

      {error && !items ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert>{errorMessage(error)}</Alert>
          <button type="button" className={quietButton} onClick={reload}>
            <RotateCw size={12} aria-hidden />
            {t("common", K.retry)}
          </button>
        </div>
      ) : items === null ? (
        <TableSkeleton rows={5} columns={3} withPagination={false} />
      ) : items.length === 0 ? (
        <p className="rounded-2xl border border-card-border bg-card-bg p-6 text-sm text-text-secondary">{t("common", K.empty)}</p>
      ) : (
        <>
          <ul className="divide-y divide-card-border overflow-hidden rounded-2xl border border-card-border bg-card-bg">
            {items.map((c) => (
              <li key={c.id}>
                <Link href={panelSupportInboxThreadPath(c.id)} className="flex flex-wrap items-center justify-between gap-3 p-4 hover:bg-bg-inner">
                  <div className="min-w-0 space-y-1">
                    <p dir="auto" className={`truncate text-sm text-text-primary ${c.unread > 0 ? "font-bold" : ""}`}>
                      {c.subject}
                    </p>
                    <p className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                      <span>{formatInstant(c.lastMessageAt, lang) ?? ""}</span>
                      <span>·</span>
                      <span>{t("common", c.assignedToUserId === null ? K.unassigned : c.assignedToUserId === me?.userId ? K.assignedToMe : K.assignedOther)}</span>
                      {c.mode === "live" && <span className="font-bold text-primary">{t("common", K.liveMode)}</span>}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {c.unread > 0 && <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-on-accent">{t("common", K.unread, { n: c.unread })}</span>}
                    <PriorityPill priority={c.priority} />
                    <SlaBadge conversation={c} now={now} />
                    <StatusPill status={c.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          {nextAfter && (
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

export function PriorityPill({ priority }: { priority: AgentConversation["priority"] }) {
  const { t } = useLocale();
  const tone = priority === "urgent" ? "bg-error/10 text-error" : priority === "high" ? "bg-primary/10 text-primary" : "bg-bg-inner text-text-secondary";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${tone}`}>{t("common", PRIORITY_KEYS[priority] ?? K.priority.normal)}</span>;
}

export function SlaBadge({ conversation: c, now }: { conversation: AgentConversation; now: number }) {
  const { lang, t } = useLocale();
  const state = slaState(c.sla, now);
  if (c.status === "closed") return null;
  const tone = state === "breached" ? "bg-error/10 text-error" : state === "soon" ? "bg-primary/10 text-primary" : "bg-bg-inner text-text-secondary";
  const text = state === "running" ? t("common", K.sla.running, { time: formatInstant(c.sla.dueAt, lang) ?? "" }) : t("common", K.sla[state]);
  return <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${tone}`}>{text}</span>;
}
