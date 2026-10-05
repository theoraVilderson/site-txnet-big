"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Check, CheckCheck, Paperclip, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import {
  SUPPORT_BODY_MAX,
  SUPPORT_FILE_TYPES,
  supportApi,
  type SupportChannel,
  type SupportConversation,
  type SupportMessage,
} from "@/lib/support-api";
import { formatInstant } from "../../_lib/datetime";
import { usePanelRealtime } from "../../_context/PanelRealtimeContext";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { Alert, input, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";
import {
  SUPPORT_KEYS as K,
  acceptSupportFiles,
  applySupportEvent,
  isSendKey,
  mergeMessages,
  readSupportEvent,
  senderKey,
  threadActions,
  typingGate,
  type ThreadState,
} from "../_lib/support";
import { StatusPill } from "./SupportView";
import { PageHeader } from "../../_components/kit/PageHeader";
import { Alert as KitAlert } from "../../_components/kit/Alert";
import { PendingFiles, useFileDrop } from "./SupportFiles";
import { AttachmentList, JumpToLatest, SendButton, StarRating, ThreadMessages, TypingDots, useAutoGrow, useFollowLatest } from "./ThreadParts";

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
  // A new ticket's files that did not go with it (UX-1-w, T3) — said until some are sent.
  const [filesFailed, setFilesFailed] = useState(useSearchParams().get("files") === "failed");

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

  // New messages scroll into view near the bottom; away from it they wait behind a button (T4).
  const scrollerRef = useRef<HTMLDivElement>(null);
  const follow = useFollowLatest(scrollerRef, thread?.messages.length ?? 0, thread?.messages.at(-1)?.mine ?? false);

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
      <PageHeader
        tail={conversation.subject}
        title={<span dir="auto">{conversation.subject}</span>}
        subtitle={liveOff && t("common", K.thread.liveOff)}
        actions={<StatusPill status={thread.status} />}
      />

      <div className="relative">
        <section
          ref={scrollerRef}
          onScroll={follow.onScroll}
          className="max-h-[calc(100dvh-22rem)] min-h-[16rem] space-y-3 overflow-y-auto rounded-2xl border border-card-border bg-card-bg p-4"
        >
          {hasEarlier && (
            <div className="text-center">
              <button type="button" className={quietButton} onClick={earlier}>
                {t("common", K.thread.earlier)}
              </button>
            </div>
          )}
          <ThreadMessages
            messages={thread.messages}
            senderOf={(m) => (m.mine ? "me" : m.senderKind)}
            render={(m, first) => (
              <MessageBubble
                message={m}
                first={first}
                seen={m.mine && m.seq === lastMine?.seq ? thread.seenUpToSeq >= m.seq : null}
                time={formatInstant(m.createdAt, lang) ?? ""}
              />
            )}
          />
          {agentTyping && <TypingDots label={t("common", K.thread.typing)} />}
        </section>
        <JumpToLatest follow={follow} />
      </div>

      {filesFailed && actions.canWrite && (
        <KitAlert tone="warning" title={t("common", K.ticket.filesFailedTitle)}>
          {t("common", K.ticket.filesFailed)}
        </KitAlert>
      )}
      {thread.status === "resolved" && <p className="text-xs text-text-secondary">{t("common", K.thread.resolved)}</p>}
      {actions.canWrite ? (
        <Composer
          id={id}
          onSent={(m) => {
            setThread((s) => s && { ...s, messages: mergeMessages(s.messages, [m]) });
            if (m.attachments.length > 0) setFilesFailed(false);
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

function MessageBubble({ message: m, first, seen, time }: { message: SupportMessage; first: boolean; seen: boolean | null; time: string }) {
  const { t } = useLocale();
  return (
    <div className={`flex ${m.mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] space-y-1 rounded-2xl px-3 py-2 ${m.mine ? "bg-primary/10" : "bg-bg-inner"}`}>
        {first && <p className="text-[11px] font-bold text-text-secondary">{t("common", senderKey(m.senderKind, m.mine))}</p>}
        {m.body && (
          <p dir="auto" className="whitespace-pre-wrap break-words text-sm text-text-primary">
            {m.body}
          </p>
        )}
        <AttachmentList attachments={m.attachments} />
        <p className="flex items-center gap-1 text-[11px] text-text-secondary">
          {time}
          {seen !== null && (
            <span title={seen ? t("common", K.thread.seen) : undefined} className="inline-flex">
              {seen ? <CheckCheck size={12} className="text-primary" aria-label={t("common", K.thread.seen)} /> : <Check size={12} aria-hidden />}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * The user's composer (T4): it grows with its text; Ctrl/⌘+Enter sends and
 * Enter is a line; a pasted or dropped file joins the message, as support
 * accepts them (`acceptSupportFiles`).
 */
function Composer({ id, onSent }: { id: string; onSent: (m: SupportMessage) => void }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [refused, setRefused] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const gate = useRef(typingGate(TYPING_EVERY_MS));
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(box, body);

  function addFiles(picked: File[]) {
    if (picked.length === 0) return;
    const { accepted, refused: names } = acceptSupportFiles(picked);
    setFiles((held) => [...held, ...accepted]);
    setRefused(names);
  }
  const drop = useFileDrop(addFiles, busy);

  function typed(value: string) {
    setBody(value);
    if (value.trim() && gate.current.shouldSend(Date.now())) supportApi.typing(id).catch(() => undefined);
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = body.trim();
    if (busy || (!text && files.length === 0)) return;
    setBusy(true);
    setFailure(null);
    try {
      onSent(files.length > 0 ? await supportApi.attach(id, files, text || undefined) : await supportApi.send(id, text));
      setBody("");
      setFiles([]);
      setRefused([]);
      gate.current.reset();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      {...drop.handlers}
      className={`relative space-y-2 rounded-2xl border p-3 transition-colors ${drop.active ? "border-dashed border-[var(--accent-primary)] bg-[var(--leaf-bg)]" : "border-card-border bg-card-bg"}`}
    >
      {drop.active && (
        <p className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl text-sm font-bold text-primary">{t("common", K.thread.dropFiles)}</p>
      )}
      <textarea
        ref={box}
        dir="auto"
        rows={2}
        className={`${input} resize-none`}
        placeholder={t("common", K.thread.placeholder)}
        value={body}
        maxLength={SUPPORT_BODY_MAX}
        onChange={(e) => typed(e.target.value)}
        onKeyDown={(e) => {
          if (!isSendKey({ ...e, isComposing: e.nativeEvent.isComposing })) return;
          e.preventDefault();
          void submit();
        }}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData?.files ?? []);
          if (pasted.length === 0) return;
          e.preventDefault();
          addFiles(pasted);
        }}
      />
      <PendingFiles files={files} disabled={busy} onRemove={(i) => setFiles((held) => held.filter((_, j) => j !== i))} />
      {refused.length > 0 && <Alert>{t("common", K.ticket.filesRefused, { names: refused.join(", ") })}</Alert>}
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
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <button type="button" className={quietButton} onClick={() => picker.current?.click()} disabled={busy}>
            <Paperclip size={12} aria-hidden />
            {t("common", K.thread.attach)}
          </button>
          <span className="text-[11px] text-text-secondary">{t("common", K.thread.attachHint)}</span>
        </div>
        <SendButton label={t("common", K.thread.send)} busy={busy} disabled={!body.trim() && files.length === 0} />
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
      <StarRating value={score} onChange={setScore} label={t("common", K.rating.title)} starLabel={(n) => t("common", K.rating.star, { n })} />
      <input dir="auto" className={input} placeholder={t("common", K.rating.comment)} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
      {failure && <Alert>{failure}</Alert>}
      <button type="submit" className={primaryButton} disabled={busy || score < 1}>
        {t("common", K.rating.submit)}
      </button>
    </form>
  );
}
