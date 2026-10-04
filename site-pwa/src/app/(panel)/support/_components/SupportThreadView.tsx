"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowRight, Check, CheckCheck, FileText, Paperclip, RotateCw, Send, Star, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { PANEL_SUPPORT } from "@/lib/routes";
import {
  SUPPORT_BODY_MAX,
  SUPPORT_FILE_TYPES,
  supportApi,
  type SupportAttachment,
  type SupportChannel,
  type SupportConversation,
  type SupportMessage,
} from "@/lib/support-api";
import { formatInstant } from "../../_lib/datetime";
import { usePanelRealtime } from "../../_context/PanelRealtimeContext";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { Alert, input, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";
import {
  SCAN_KEYS,
  SUPPORT_KEYS as K,
  applySupportEvent,
  fileSize,
  mergeMessages,
  readSupportEvent,
  senderKey,
  threadActions,
  typingGate,
  type ThreadState,
} from "../_lib/support";
import { StatusPill } from "./SupportView";

/** Below the server's ~6s hold, so a steady typist never flickers off. */
const TYPING_EVERY_MS = 4_000;

/**
 * One conversation (F-033-o): the stored thread, kept live by the
 * `support:<id>` channel (F-034, ADR-0114). The channel is at-most-once, so
 * the thread is the record: a skipped `seq` or a reconnect re-reads from the
 * last held message, and a page with no channel still reads and writes.
 */
export function SupportThreadView({ id }: { id: string }) {
  const { lang, t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const client = usePanelRealtime();

  const [thread, setThread] = useState<ThreadState | null>(null);
  const [conversation, setConversation] = useState<SupportConversation | null>(null);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [lastReadSeq, setLastReadSeq] = useState(0);
  const [channel, setChannel] = useState<SupportChannel | null>(null);
  const [liveOff, setLiveOff] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const [now, setNow] = useState(() => Date.now());

  // The latest page: on mount, on reload, and after a reopen. It also carries a fresh channel proof.
  useEffect(() => {
    let alive = true;
    supportApi
      .messages(id)
      .then((page) => {
        if (!alive) return;
        setConversation(page.conversation);
        setThread({
          conversationId: page.conversation.id,
          status: page.conversation.status,
          messages: page.messages,
          seenUpToSeq: page.seenUpToSeq,
          peerTypingUntil: 0,
        });
        setHasEarlier(page.hasEarlier);
        setLastReadSeq(page.lastReadSeq);
        setChannel(page.realtime);
        setLiveOff(page.realtime === null);
        setError(null);
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [id, asked]);

  // Whatever came after the last held message — a gap, a reconnect, our own send.
  // The socket handler reads the thread from here, not from a stale closure.
  const threadRef = useRef<ThreadState | null>(null);
  useEffect(() => {
    threadRef.current = thread;
  }, [thread]);
  const catchUp = useCallback(async () => {
    try {
      const page = await supportApi.messages(id, { afterSeq: threadRef.current?.messages.at(-1)?.seq ?? 0 });
      setConversation(page.conversation);
      setThread((s) =>
        s && {
          ...s,
          status: page.conversation.status,
          messages: mergeMessages(s.messages, page.messages),
          seenUpToSeq: Math.max(s.seenUpToSeq, page.seenUpToSeq),
        },
      );
    } catch {
      // The next event or the next send tries again; the thread on screen is still true.
    }
  }, [id]);

  // The channel. Keyed to the proof: a re-read hands a fresh one and re-subscribes.
  const reproved = useRef(false);
  useEffect(() => {
    if (!client || !channel) return;
    return client.subscribe(channel.channel, {
      proof: channel.proof,
      onMessage: (payload) => {
        const event = readSupportEvent(payload, id);
        if (!event) return;
        // Applied to the ref, not inside an updater: React may run that later,
        // and the gap check has to answer now.
        const held = threadRef.current;
        if (!held) return;
        const { next, reread } = applySupportEvent(held, event, Date.now());
        threadRef.current = next;
        setThread(next);
        if (event.kind === "support.message" || event.kind === "support.status") {
          setConversation((c) => c && { ...c, status: event.status });
        }
        if (event.kind === "support.typing") setNow(Date.now());
        if (reread) void catchUp();
      },
      onMissed: () => void catchUp(),
      onError: () => {
        // An expired proof is refused like a forged one: re-read once for a fresh proof, then give up.
        if (reproved.current) return setLiveOff(true);
        reproved.current = true;
        reload();
      },
    });
  }, [client, channel, id, catchUp, reload]);

  // The agent's typing fades by itself.
  useEffect(() => {
    if (!thread || thread.peerTypingUntil <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), thread.peerTypingUntil - now + 50);
    return () => clearTimeout(timer);
  }, [thread, now]);

  // Reading the thread moves the cursor — only while the tab is actually shown.
  const lastSeq = thread?.messages.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (lastSeq <= lastReadSeq || document.visibilityState !== "visible") return;
    const timer = setTimeout(() => {
      supportApi
        .read(id, lastSeq)
        .then((r) => setLastReadSeq(r.lastReadSeq))
        .catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [id, lastSeq, lastReadSeq]);

  // New messages scroll into view.
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastSeq]);

  async function earlier() {
    const first = thread?.messages[0]?.seq;
    if (first === undefined) return;
    try {
      const page = await supportApi.messages(id, { beforeSeq: first });
      setThread((s) => s && { ...s, messages: mergeMessages(page.messages, s.messages) });
      setHasEarlier(page.hasEarlier);
    } catch (e) {
      setError(e);
    }
  }

  if (error && !thread) {
    return (
      <Frame>
        <div className="flex flex-wrap items-center gap-3">
          <Alert>{errorMessage(error)}</Alert>
          <button type="button" className={quietButton} onClick={reload}>
            <RotateCw size={12} aria-hidden />
            {t("common", K.retry)}
          </button>
        </div>
      </Frame>
    );
  }
  if (!thread || !conversation) {
    return (
      <Frame>
        <TableSkeleton rows={5} columns={1} withPagination={false} />
      </Frame>
    );
  }

  const actions = threadActions(thread.status, conversation.rating);
  const lastMine = [...thread.messages].reverse().find((m) => m.mine);
  const agentTyping = thread.peerTypingUntil > now;

  return (
    <Frame>
      <header className="space-y-2">
        <Link href={PANEL_SUPPORT} className={quietButton}>
          <ArrowRight size={12} className="ltr:rotate-180" aria-hidden />
          {t("common", K.thread.back)}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 dir="auto" className="text-xl font-bold text-text-primary">
            {conversation.subject}
          </h1>
          <StatusPill status={thread.status} />
        </div>
        {liveOff && <p className="text-xs text-text-secondary">{t("common", K.thread.liveOff)}</p>}
      </header>

      <section className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
        {hasEarlier && (
          <div className="text-center">
            <button type="button" className={quietButton} onClick={earlier}>
              {t("common", K.thread.earlier)}
            </button>
          </div>
        )}
        <ol className="space-y-3">
          {thread.messages.map((m) => (
            <MessageBubble
              key={m.seq}
              message={m}
              seen={m.mine && m.seq === lastMine?.seq ? thread.seenUpToSeq >= m.seq : null}
              time={formatInstant(m.createdAt, lang) ?? ""}
            />
          ))}
        </ol>
        {agentTyping && <p className="text-xs text-text-secondary">{t("common", K.thread.typing)}</p>}
        <div ref={endRef} />
      </section>

      {thread.status === "resolved" && <p className="text-xs text-text-secondary">{t("common", K.thread.resolved)}</p>}
      {actions.canWrite ? (
        <Composer
          id={id}
          onSent={(m) => {
            setThread((s) => s && { ...s, messages: mergeMessages(s.messages, [m]) });
            setLastReadSeq((n) => Math.max(n, m.seq));
            // The status moved server-side (a resolved thread reopens); the channel may not be there to say so.
            void catchUp();
          }}
        />
      ) : (
        <Reopen id={id} onReopened={reload} />
      )}
      {actions.canRate && <RatingForm id={id} onRated={(rating) => setConversation((c) => c && { ...c, rating })} />}
      {conversation.rating && (
        <p className="text-xs text-text-secondary">{t("common", K.rating.yours, { n: conversation.rating.score })}</p>
      )}
    </Frame>
  );
}

export function Frame({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-8">{children}</div>;
}

function MessageBubble({ message: m, seen, time }: { message: SupportMessage; seen: boolean | null; time: string }) {
  const { t } = useLocale();
  return (
    <li className={`flex ${m.mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] space-y-1 rounded-2xl px-3 py-2 ${m.mine ? "bg-primary/10" : "bg-bg-inner"}`}>
        <p className="text-[11px] font-bold text-text-secondary">{t("common", senderKey(m.senderKind, m.mine))}</p>
        {m.body && (
          <p dir="auto" className="whitespace-pre-wrap break-words text-sm text-text-primary">
            {m.body}
          </p>
        )}
        {m.attachments.length > 0 && (
          <ul className="space-y-1">
            {m.attachments.map((a) => (
              <AttachmentRow key={a.id} attachment={a} />
            ))}
          </ul>
        )}
        <p className="flex items-center gap-1 text-[11px] text-text-secondary">
          {time}
          {seen !== null && (
            <span title={seen ? t("common", K.thread.seen) : undefined} className="inline-flex">
              {seen ? <CheckCheck size={12} className="text-primary" aria-label={t("common", K.thread.seen)} /> : <Check size={12} aria-hidden />}
            </span>
          )}
        </p>
      </div>
    </li>
  );
}

export function AttachmentRow({ attachment: a }: { attachment: SupportAttachment }) {
  const { t } = useLocale();
  const size = fileSize(a.sizeBytes);
  const label = (
    <>
      <FileText size={14} aria-hidden />
      <span dir="auto" className="truncate">
        {a.fileName}
      </span>
      <span className="shrink-0 text-text-secondary">({t("common", size.key, { n: size.n })})</span>
    </>
  );
  if (a.expired) {
    return <li className="flex items-center gap-1 text-xs text-text-secondary">{label} — {t("common", K.thread.expired)}</li>;
  }
  if (a.url) {
    // Minted on the read, valid five minutes: a stale one fails, and the next read of the thread mints another.
    return (
      <li>
        <a href={a.url} target="_blank" rel="noopener noreferrer" title={t("common", K.thread.open)} className="flex items-center gap-1 text-xs font-bold text-primary hover:underline">
          {label}
        </a>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-1 text-xs text-text-secondary">
      {label} — {t("common", SCAN_KEYS[a.scanStatus] ?? K.scan.pending)}
    </li>
  );
}

function Composer({ id, onSent }: { id: string; onSent: (m: SupportMessage) => void }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const gate = useRef(typingGate(TYPING_EVERY_MS));
  const picker = useRef<HTMLInputElement>(null);

  function typed(value: string) {
    setBody(value);
    if (value.trim() && gate.current.shouldSend(Date.now())) supportApi.typing(id).catch(() => undefined);
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = body.trim();
    if (!text && files.length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      onSent(files.length > 0 ? await supportApi.attach(id, files, text || undefined) : await supportApi.send(id, text));
      setBody("");
      setFiles([]);
      gate.current.reset();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-2xl border border-card-border bg-card-bg p-3">
      <textarea
        dir="auto"
        rows={3}
        className={input}
        placeholder={t("common", K.thread.placeholder)}
        value={body}
        maxLength={SUPPORT_BODY_MAX}
        onChange={(e) => typed(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
        }}
      />
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-1 rounded-lg bg-bg-inner px-2 py-1 text-xs text-text-primary">
              <span dir="auto" className="max-w-[12rem] truncate">
                {f.name}
              </span>
              <button type="button" aria-label={t("common", K.thread.removeFile)} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {failure && <Alert>{failure}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            accept={SUPPORT_FILE_TYPES.join(",")}
            onChange={(e) => {
              setFiles([...files, ...Array.from(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <button type="button" className={quietButton} onClick={() => picker.current?.click()} disabled={busy}>
            <Paperclip size={12} aria-hidden />
            {t("common", K.thread.attach)}
          </button>
          <span className="text-[11px] text-text-secondary">{t("common", K.thread.attachHint)}</span>
        </div>
        <button type="submit" className={primaryButton} disabled={busy || (!body.trim() && files.length === 0)}>
          <Send size={12} className="ltr:rotate-0 rtl:-scale-x-100" aria-hidden />
          {t("common", K.thread.send)}
        </button>
      </div>
    </form>
  );
}

function Reopen({ id, onReopened }: { id: string; onReopened: () => void }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-card-border bg-card-bg p-3 text-xs text-text-secondary">
      <span>{t("common", K.thread.closed)}</span>
      <button
        type="button"
        className={quietButton}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailure(null);
          try {
            await supportApi.reopen(id);
            onReopened();
          } catch (e) {
            // `reopen_expired` says to open a new one, in support's own words.
            setFailure(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <RotateCw size={12} aria-hidden />
        {t("common", K.thread.reopen)}
      </button>
      {failure && <Alert>{failure}</Alert>}
    </div>
  );
}

function RatingForm({ id, onRated }: { id: string; onRated: (r: NonNullable<SupportConversation["rating"]>) => void }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (score < 1) return;
    setBusy(true);
    setFailure(null);
    try {
      onRated(await supportApi.rate(id, score, comment.trim() || undefined));
    } catch (err) {
      setFailure(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-2xl border border-card-border bg-card-bg p-3">
      <p className="text-sm font-bold text-text-primary">{t("common", K.rating.title)}</p>
      <div className="flex gap-1" role="radiogroup" aria-label={t("common", K.rating.title)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={score === n}
            aria-label={t("common", K.rating.star, { n })}
            onClick={() => setScore(n)}
            className="p-0.5"
          >
            <Star size={20} className={n <= score ? "fill-primary text-primary" : "text-text-secondary"} aria-hidden />
          </button>
        ))}
      </div>
      <input dir="auto" className={input} placeholder={t("common", K.rating.comment)} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
      {failure && <Alert>{failure}</Alert>}
      <button type="submit" className={primaryButton} disabled={busy || score < 1}>
        {t("common", K.rating.submit)}
      </button>
    </form>
  );
}
