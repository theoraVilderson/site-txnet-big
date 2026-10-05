"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Headphones, Inbox, Plus, RotateCw, Search, SearchX } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { PANEL_SUPPORT, panelSupportThreadPath } from "@/lib/routes";
import { supportApi, type SupportAvailability, type SupportConversation, type SupportCounts, type SupportListedConversation } from "@/lib/support-api";
import { formatInstant, formatRelative } from "../../_lib/datetime";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { Alert, Button, EmptyState, Input, StatusPill as KitStatusPill, Tabs, type Tone } from "../../_components/kit";
import { PageHeader } from "../../_components/kit/PageHeader";
import {
  SEARCH_MAX,
  SEARCH_MIN,
  STATUS_KEYS,
  SUPPORT_KEYS as K,
  TICKET_TABS,
  readTicketTab,
  tabCount,
  tabStatuses,
  type TicketTab,
} from "../_lib/support";
import { NewTicketSheet } from "./NewTicketSheet";

/** Typing rests this long before the search goes to the URL, and so to the server (T2). */
const SEARCH_REST_MS = 300;

const TAB_KEYS: Record<TicketTab, string> = K.tabs;

/**
 * The user's tickets (F-033-o; UX-1-w, `contract.ux.md` T2–T3): tabs by status
 * with the server's counts, a search, newest activity first, and a new ticket
 * in a sheet. The tab and the search live in the URL (`?status=&q=`) and are
 * the server's to apply (UX-1-v) — the browser holds one page of 30 and would
 * filter only that.
 */
export function SupportView() {
  const { lang, t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const tab = readTicketTab(params.get("status"));
  const q = params.get("q") ?? "";
  const [typed, setTyped] = useState(q);

  const [counts, setCounts] = useState<SupportCounts | null>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  // What is held answers one tab, search and reload; another one reads as loading until its own lands.
  const listKey = `${tab}|${q}|${asked}`;
  const [held, setHeld] = useState<{ key: string; items: SupportListedConversation[]; nextBefore: string | null } | null>(null);
  const [failed, setFailed] = useState<{ key: string; error: unknown } | null>(null);
  const items = held?.key === listKey ? held.items : null;
  const nextBefore = held?.key === listKey ? held.nextBefore : null;
  const error = failed?.key === listKey ? failed.error : null;
  const [availability, setAvailability] = useState<SupportAvailability | null>(null);

  // `?new=1` (the palette's "new ticket", UX-1-n) opens the sheet; closing it drops the query.
  const askedNew = params.get("new") === "1";
  const [opened, setOpened] = useState(false);
  const composing = opened || askedNew;
  const closeComposer = () => {
    setOpened(false);
    if (askedNew) router.replace(PANEL_SUPPORT, { scroll: false });
  };

  // The search box, rested, becomes `?q=` — below support's floor it is no search at all.
  useEffect(() => {
    const want = typed.trim().length >= SEARCH_MIN ? typed.trim() : "";
    if (want === q) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (want) next.set("q", want);
      else next.delete("q");
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }, SEARCH_REST_MS);
    return () => clearTimeout(timer);
  }, [typed, q, params, pathname, router]);

  useEffect(() => {
    let alive = true;
    const key = `${tab}|${q}|${asked}`;
    supportApi
      .list({ status: tabStatuses(tab), q: q || undefined })
      .then((page) => alive && setHeld({ key, items: page.items, nextBefore: page.nextBefore }))
      .catch((e) => alive && setFailed({ key, error: e }));
    return () => {
      alive = false;
    };
  }, [tab, q, asked]);

  useEffect(() => {
    let alive = true;
    // Counts and the wait notice are courtesies: a failed read shows none, never an error.
    supportApi
      .counts()
      .then((c) => alive && setCounts(c))
      .catch(() => undefined);
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
    const key = listKey;
    try {
      const page = await supportApi.list({ before: nextBefore, status: tabStatuses(tab), q: q || undefined });
      setHeld((h) =>
        h?.key === key ? { key, items: [...h.items, ...page.items.filter((c) => !h.items.some((i) => i.id === c.id))], nextBefore: page.nextBefore } : h,
      );
    } catch (e) {
      setFailed({ key, error: e });
    }
  }

  const filtered = tab !== "all" || q !== "";
  const newTicket = (
    <Button icon={<Plus size={16} aria-hidden />} onClick={() => setOpened(true)}>
      {t("common", K.newConversation)}
    </Button>
  );

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-4 md:p-8">
      <PageHeader icon={Headphones} title={t("common", K.title)} subtitle={t("common", K.subtitle)} actions={newTicket} />

      {availability && <AvailabilityNotice availability={availability} />}

      <div className="space-y-3">
        <Tabs<TicketTab>
          ariaLabel={t("common", K.tabs.label)}
          urlParam="status"
          variant="pills"
          tabs={TICKET_TABS.map((value) => ({
            value,
            label: t("common", TAB_KEYS[value]),
            badge: counts ? String(tabCount(value, counts)) : undefined,
          }))}
        />
        <Input
          type="search"
          dir="auto"
          aria-label={t("common", K.search.label)}
          placeholder={t("common", K.search.placeholder)}
          maxLength={SEARCH_MAX}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          end={<Search size={16} className="text-text-secondary" aria-hidden />}
        />
      </div>

      {error && !items ? (
        <Alert
          tone="error"
          action={
            <Button variant="quiet" size="sm" icon={<RotateCw size={14} aria-hidden />} onClick={reload}>
              {t("common", K.retry)}
            </Button>
          }
        >
          {errorMessage(error)}
        </Alert>
      ) : items === null ? (
        <TableSkeleton rows={4} columns={2} withPagination={false} />
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState icon={SearchX} title={t("common", K.emptyFiltered)} />
        ) : (
          <EmptyState icon={Inbox} title={t("common", K.empty)} action={newTicket} />
        )
      ) : (
        <>
          <ul className="divide-y divide-card-border overflow-hidden rounded-2xl border border-card-border bg-card-bg">
            {items.map((c) => (
              <TicketRow key={c.id} conversation={c} lang={lang} />
            ))}
          </ul>
          {nextBefore && (
            <Button variant="quiet" onClick={more}>
              {t("common", K.more)}
            </Button>
          )}
          {error !== null && <Alert tone="error">{errorMessage(error)}</Alert>}
        </>
      )}

      <NewTicketSheet
        open={composing}
        onClose={closeComposer}
        onOpened={(c, { filesFailed }) => {
          setOpened(false);
          router.push(`${panelSupportThreadPath(c.id)}${filesFailed ? "?files=failed" : ""}`);
        }}
      />
    </div>
  );
}

/** One ticket: its status, an unread dot, the subject, the last line and how long ago (T2). */
function TicketRow({ conversation: c, lang }: { conversation: SupportListedConversation; lang: string }) {
  const { t } = useLocale();
  const unread = c.unread > 0;
  return (
    <li>
      <Link href={panelSupportThreadPath(c.id)} className="flex items-start gap-3 p-4 transition-colors hover:bg-bg-inner">
        <span className="mt-1.5 flex size-2.5 shrink-0 items-center justify-center">
          {unread && <span role="img" aria-label={t("common", K.unread, { n: c.unread })} className="size-2.5 rounded-full bg-primary" />}
        </span>
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex items-center justify-between gap-2">
            <span dir="auto" className={`truncate text-sm text-text-primary ${unread ? "font-bold" : "font-medium"}`}>
              {c.subject}
            </span>
            <time dateTime={c.lastMessageAt} title={formatInstant(c.lastMessageAt, lang) ?? undefined} className="shrink-0 text-[11px] text-text-secondary">
              {formatRelative(c.lastMessageAt, lang)}
            </time>
          </span>
          <span className="flex items-center justify-between gap-2">
            <span dir="auto" className={`truncate text-xs ${unread ? "text-text-primary" : "text-text-secondary"}`}>
              {c.lastLine ?? t("common", K.noMessage)}
            </span>
            <StatusPill status={c.status} />
          </span>
        </span>
      </Link>
    </li>
  );
}

/** The user's words for a status, on the kit pill: theirs to act on is `warning`, settled is `success`. */
const STATUS_TONE: Record<SupportConversation["status"], Tone> = {
  open: "info",
  pending_agent: "info",
  pending_user: "warning",
  resolved: "success",
  closed: "neutral",
};

export function StatusPill({ status }: { status: SupportConversation["status"] }) {
  const { t } = useLocale();
  return (
    <KitStatusPill tone={STATUS_TONE[status] ?? "neutral"} className="shrink-0">
      {t("common", STATUS_KEYS[status] ?? K.status.open)}
    </KitStatusPill>
  );
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
