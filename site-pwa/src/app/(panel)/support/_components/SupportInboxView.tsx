"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Inbox, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { useLiveReread } from "@/hooks/useLiveReread";
import { panelSupportInboxThreadPath } from "@/lib/routes";
import { supportAgentApi, type AgentConversation, type InboxView } from "@/lib/support-api";
import { tenantChannelOf } from "@/lib/tenant-channel";
import { formatInstant } from "../../_lib/datetime";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { AGENT_KEYS as K, INBOX_EVENTS, INBOX_VIEWS, PRIORITY_KEYS, VIEW_KEYS, assigneeOf, slaState } from "../_lib/support-agent";
import { StatusPill } from "./SupportView";
import { usePresence } from "./usePresence";
import { PageHeader } from "../../_components/kit/PageHeader";
import { Alert, Button, IconButton, Tabs } from "../../_components/kit";

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

  // A thread opened, answered, assigned or settled anywhere in the tenant moves this queue (RT-1-g).
  useLiveReread(tenantChannelOf(me), INBOX_EVENTS, reload);

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
      <PageHeader
        icon={Inbox}
        title={t("common", K.title)}
        subtitle={t("common", K.subtitle)}
        actions={
          <>
            <div className="flex items-center gap-2 rounded-xl border border-card-border bg-card-bg px-3 py-2 text-xs text-text-secondary">
              <span className={`inline-block h-2 w-2 rounded-full ${presence.online ? "bg-success" : "bg-text-secondary/40"}`} aria-hidden />
              {t("common", presence.online ? K.presence.online : K.presence.away)}
              <Button variant="quiet" size="sm" onClick={presence.toggle}>
                {t("common", presence.online ? K.presence.goAway : K.presence.goOnline)}
              </Button>
            </div>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          ariaLabel={t("common", K.title)}
          variant="pills"
          value={view}
          onChange={(v) => {
            setItems(null);
            setView(v);
          }}
          tabs={INBOX_VIEWS.map((v) => ({ value: v, label: t("common", VIEW_KEYS[v]) }))}
        />
        <IconButton size="sm" onClick={reload} aria-label={t("common", K.retry)} icon={<RotateCw size={12} aria-hidden />} />
      </div>

      {error && !items ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert tone="error">{errorMessage(error)}</Alert>
          <Button variant="quiet" size="sm" onClick={reload} icon={<RotateCw size={12} aria-hidden />}>
            {t("common", K.retry)}
          </Button>
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
                      <AssigneeLabel conversation={c} me={me?.userId} />
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
            <Button variant="quiet" size="sm" onClick={more}>
              {t("common", K.more)}
            </Button>
          )}
          {error !== null && <Alert tone="error">{errorMessage(error)}</Alert>}
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

/** Who has the conversation (F-033-r): nobody, me, or the colleague by name when support knows it. */
export function AssigneeLabel({ conversation, me }: { conversation: AgentConversation; me: string | undefined }) {
  const { t } = useLocale();
  const who = assigneeOf(conversation, me);
  return <span>{"name" in who && who.name ? t("common", K.assignedNamed, { name: who.name }) : t("common", K[who.key])}</span>;
}
