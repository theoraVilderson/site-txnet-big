"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Check, CheckCheck, CheckCircle2, ExternalLink, Hand, Lock, RotateCw, Send, StickyNote, XCircle } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import {
  SUPPORT_BODY_MAX,
  supportAgentApi,
  type AgentConversation,
  type AgentMessage,
  type CannedPick,
  type SupportChannel,
  type SupportPriority,
} from "@/lib/support-api";
import { formatInstant } from "../../_lib/datetime";
import { formatMoney } from "../../_lib/money";
import { formatBytes } from "../../services/_lib/service-configs";
import { usePanelRealtime } from "../../_context/PanelRealtimeContext";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { applySupportEvent, isSendKey, mergeMessages, readSupportEvent, senderKey, typingGate, type ThreadState } from "../_lib/support";
import { AGENT_KEYS as K, PRIORITIES, PRIORITY_KEYS, agentActions, senderNameOf, userLinksOf } from "../_lib/support-agent";
import { AssigneeLabel } from "./SupportInboxView";
import { Frame } from "./SupportThreadView";
import { AttachmentList, JumpToLatest, SendButton, ThreadMessages, TypingDots, useAutoGrow, useFollowLatest } from "./ThreadParts";
import { StatusPill } from "./SupportView";
import { PriorityPill, SlaBadge } from "./SupportInboxView";
import { usePresence } from "./usePresence";
import { UserStatusControl } from "./UserStatusControl";
import { PageHeader } from "../../_components/kit/PageHeader";
import { Alert, Button, Field, NativeSelect, SegmentedControl, Textarea, buttonClass, useConfirm } from "../../_components/kit";

const TYPING_EVERY_MS = 4_000;

/**
 * One conversation as an agent sees it (F-033-p) over
 * `/api/support/agent/conversations/:id/*` (F-033-d): notes among the
 * messages, the actions support accepts, and the user's sidebar (F-033-m).
 *
 * Live over the same `support:<id>` channel as the user, but a message event
 * is a signal to re-read, never applied: it carries the user's view, with no
 * `internal` and no sender account (support invariant 5).
 */
export function AgentThreadView({ id }: { id: string }) {
  const { lang, t } = useLocale();
  const confirm = useConfirm();
  const errorMessage = useApiErrorMessage();
  const client = usePanelRealtime();
  const { me } = usePanelSession();
  usePresence();

  const [thread, setThread] = useState<ThreadState<AgentMessage> | null>(null);
  const [conversation, setConversation] = useState<AgentConversation | null>(null);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [lastReadSeq, setLastReadSeq] = useState(0);
  const [channel, setChannel] = useState<SupportChannel | null>(null);
  const [liveOff, setLiveOff] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    supportAgentApi
      .messages(id)
      .then((page) => {
        if (!alive) return;
        setConversation(page.conversation);
        setThread({ conversationId: page.conversation.id, status: page.conversation.status, messages: page.messages, seenUpToSeq: page.seenUpToSeq, peerTypingUntil: 0 });
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

  const threadRef = useRef<ThreadState<AgentMessage> | null>(null);
  useEffect(() => {
    threadRef.current = thread;
  }, [thread]);

  const catchUp = useCallback(async () => {
    try {
      const page = await supportAgentApi.messages(id, { afterSeq: threadRef.current?.messages.at(-1)?.seq ?? 0 });
      setConversation(page.conversation);
      setThread(
        (s) =>
          s && {
            ...s,
            status: page.conversation.status,
            messages: mergeMessages(s.messages, page.messages),
            seenUpToSeq: Math.max(s.seenUpToSeq, page.seenUpToSeq),
          },
      );
    } catch {
      // The next event, action or reply reads again.
    }
  }, [id]);

  const reproved = useRef(false);
  useEffect(() => {
    if (!client || !channel) return;
    return client.subscribe(channel.channel, {
      proof: channel.proof,
      onMessage: (payload) => {
        const event = readSupportEvent(payload, id);
        const held = threadRef.current;
        if (!event || !held) return;
        const { next, reread } = applySupportEvent(held, event, Date.now(), "agent");
        threadRef.current = next;
        setThread(next);
        if (event.kind === "support.status") setConversation((c) => c && { ...c, status: event.status });
        if (event.kind === "support.typing") setNow(Date.now());
        if (reread) void catchUp();
      },
      onMissed: () => void catchUp(),
      onError: () => {
        if (reproved.current) return setLiveOff(true);
        reproved.current = true;
        reload();
      },
    });
  }, [client, channel, id, catchUp, reload]);

  useEffect(() => {
    if (!thread || thread.peerTypingUntil <= now) return;
    const timer = setTimeout(() => setNow(Date.now()), thread.peerTypingUntil - now + 50);
    return () => clearTimeout(timer);
  }, [thread, now]);

  const lastSeq = thread?.messages.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (lastSeq <= lastReadSeq || document.visibilityState !== "visible") return;
    const timer = setTimeout(() => {
      supportAgentApi
        .read(id, lastSeq)
        .then((r) => setLastReadSeq(r.lastReadSeq))
        .catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
  }, [id, lastSeq, lastReadSeq]);

  // Near the bottom a new message scrolls into view; away from it, it waits behind a button (T4).
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lastHeld = thread?.messages.at(-1);
  const follow = useFollowLatest(scrollerRef, thread?.messages.length ?? 0, lastHeld !== undefined && lastHeld.senderUserId === me?.userId);

  async function earlier() {
    const first = thread?.messages[0]?.seq;
    if (first === undefined) return;
    try {
      const page = await supportAgentApi.messages(id, { beforeSeq: first });
      setThread((s) => s && { ...s, messages: mergeMessages(page.messages, s.messages) });
      setHasEarlier(page.hasEarlier);
    } catch (e) {
      setFailure(errorMessage(e));
    }
  }

  /** Every action answers the conversation as it now stands. */
  async function act(work: () => Promise<AgentConversation>) {
    setBusy(true);
    setFailure(null);
    try {
      const c = await work();
      setConversation(c);
      setThread((s) => s && { ...s, status: c.status });
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (error && !thread) {
    return (
      <Frame>
        <div className="flex flex-wrap items-center gap-3">
          <Alert tone="error">{errorMessage(error)}</Alert>
          <Button variant="quiet" size="sm" onClick={reload} icon={<RotateCw size={12} aria-hidden />}>
            {t("common", K.retry)}
          </Button>
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

  const myId = me?.userId ?? "";
  const actions = agentActions(conversation, myId);
  const lastPublished = [...thread.messages].reverse().find((m) => !m.internal && m.senderKind !== "user");

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4 p-4 md:p-8 lg:grid-cols-[1fr_18rem]">
      <div className="min-w-0 space-y-4">
        <header className="space-y-2">
          <PageHeader
            tail={conversation.subject}
            title={<span dir="auto">{conversation.subject}</span>}
            actions={
              <>
                <PriorityPill priority={conversation.priority} />
                <SlaBadge conversation={conversation} now={now} />
                <StatusPill status={thread.status} />
              </>
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            {/* F-033-r: who has it, by name. */}
            <span className="text-xs text-text-secondary">
              <AssigneeLabel conversation={conversation} me={myId} />
            </span>
            {actions.canTake && (
              <Button variant="quiet" size="sm" disabled={busy} onClick={() => act(() => supportAgentApi.assign(id, myId))} icon={<Hand size={12} aria-hidden />}>
                {t("common", K.thread.take)}
              </Button>
            )}
            {actions.canRelease && (
              <Button variant="quiet" size="sm" disabled={busy} onClick={() => act(() => supportAgentApi.assign(id, null))}>
                {t("common", K.thread.release)}
              </Button>
            )}
            {actions.canPrioritize && (
              <Field label={t("common", K.thread.priority)}>
                <NativeSelect
                  className="text-xs"
                  value={conversation.priority}
                  disabled={busy}
                  onChange={(e) => act(() => supportAgentApi.priority(id, e.target.value as SupportPriority))}
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {t("common", PRIORITY_KEYS[p])}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            )}
            {actions.canResolve && (
              <Button variant="quiet" size="sm" disabled={busy} onClick={() => act(() => supportAgentApi.resolve(id))} icon={<CheckCircle2 size={12} aria-hidden />}>
                {t("common", K.thread.resolve)}
              </Button>
            )}
            {actions.canClose && (
              <Button
                variant="quiet"
                size="sm"
                disabled={busy}
                onClick={async () => (await confirm({ title: t("common", K.thread.closeConfirm), confirmLabel: t("common", K.thread.close) })) && act(() => supportAgentApi.close(id))}
                icon={<XCircle size={12} aria-hidden />}
              >
                {t("common", K.thread.close)}
              </Button>
            )}
          </div>
          {failure && <Alert tone="error">{failure}</Alert>}
          {liveOff && <p className="text-xs text-text-secondary">{t("common", K.thread.liveOff)}</p>}
        </header>

        <div className="relative">
          <section
            ref={scrollerRef}
            onScroll={follow.onScroll}
            className="max-h-[calc(100dvh-24rem)] min-h-[16rem] space-y-3 overflow-y-auto rounded-2xl border border-card-border bg-card-bg p-4"
          >
            {hasEarlier && (
              <div className="text-center">
                <Button variant="quiet" size="sm" onClick={earlier}>
                  {t("common", K.thread.earlier)}
                </Button>
              </div>
            )}
            <ThreadMessages
              messages={thread.messages}
              // One person's replies group; a note never joins a reply's group.
              senderOf={(m) => `${m.senderUserId ?? m.senderKind}:${m.internal}`}
              render={(m, first) => (
                <AgentBubble
                  message={m}
                  first={first}
                  me={myId}
                  seen={m.seq === lastPublished?.seq ? thread.seenUpToSeq >= m.seq : null}
                  time={formatInstant(m.createdAt, lang) ?? ""}
                />
              )}
            />
            {thread.peerTypingUntil > now && <TypingDots label={t("common", K.thread.typing)} />}
          </section>
          <JumpToLatest follow={follow} />
        </div>

        {conversation.rating && <p className="text-xs text-text-secondary">{t("common", K.thread.rating, { n: conversation.rating.score })}</p>}
        {actions.canWrite ? (
          <AgentComposer
            id={id}
            claims={conversation.assignedToUserId === null}
            onSent={(m) => {
              setThread((s) => s && { ...s, messages: mergeMessages(s.messages, [m]) });
              setLastReadSeq((n) => Math.max(n, m.seq));
              void catchUp();
            }}
          />
        ) : (
          <p className="flex items-center gap-2 rounded-2xl border border-card-border bg-card-bg p-3 text-xs text-text-secondary">
            <Lock size={12} aria-hidden />
            {t("common", conversation.closedAutomatically ? K.thread.closedAuto : K.thread.closed)}
          </p>
        )}
      </div>
      <Sidebar id={id} />
    </div>
  );
}

function AgentBubble({ message: m, first, me, seen, time }: { message: AgentMessage; first: boolean; me: string; seen: boolean | null; time: string }) {
  const { t } = useLocale();
  const fromUser = m.senderKind === "user";
  const label = fromUser
    ? t("common", K.thread.user)
    : m.senderUserId === me
      ? t("common", K.thread.you)
      : m.senderKind === "agent"
        ? (senderNameOf(m) ?? t("common", K.thread.colleague))
        : t("common", senderKey(m.senderKind, false));
  const tone = m.internal ? "border border-dashed border-card-border bg-bg-inner" : fromUser ? "bg-bg-inner" : "bg-primary/10";
  return (
    <div className={`flex ${fromUser ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[85%] space-y-1 rounded-2xl px-3 py-2 ${tone}`}>
        {first && (
          <p className="flex items-center gap-1 text-2xs font-bold text-text-secondary">
            {m.internal && <StickyNote size={11} aria-hidden />}
            {label}
            {m.internal && <span className="font-normal">· {t("common", K.thread.noteBadge)}</span>}
          </p>
        )}
        {m.body && (
          <p dir="auto" className="whitespace-pre-wrap break-words text-sm text-text-primary">
            {m.body}
          </p>
        )}
        <AttachmentList attachments={m.attachments} />
        <p className="flex items-center gap-1 text-2xs text-text-secondary">
          {time}
          {seen !== null &&
            (seen ? <CheckCheck size={12} className="text-primary" aria-label={t("common", K.thread.seen)} /> : <Check size={12} aria-hidden />)}
        </p>
      </div>
    </div>
  );
}

function AgentComposer({ id, claims, onSent }: { id: string; claims: boolean; onSent: (m: AgentMessage) => void }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [canned, setCanned] = useState<CannedPick[] | null>(null);
  const gate = useRef(typingGate(TYPING_EVERY_MS));
  const box = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(box, body);

  useEffect(() => {
    supportAgentApi
      .cannedPicker()
      .then(setCanned)
      .catch(() => setCanned([]));
  }, []);

  function typed(value: string) {
    setBody(value);
    // A note is the team's: the user is never told someone is typing one.
    if (!internal && value.trim() && gate.current.shouldSend(Date.now())) supportAgentApi.typing(id).catch(() => undefined);
  }

  async function insert(replyId: string) {
    if (!replyId) return;
    try {
      const filled = await supportAgentApi.canned(id, replyId);
      setBody((held) => (held.trim() ? `${held}\n${filled.body}` : filled.body));
    } catch (e) {
      setFailure(errorMessage(e));
    }
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = body.trim();
    if (busy || !text) return;
    setBusy(true);
    setFailure(null);
    try {
      onSent(await supportAgentApi.reply(id, text, internal));
      setBody("");
      gate.current.reset();
    } catch (err) {
      setFailure(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={`space-y-2 rounded-2xl border p-3 ${internal ? "border-dashed border-card-border bg-bg-inner" : "border-card-border bg-card-bg"}`}>
      <SegmentedControl<"reply" | "note">
        ariaLabel={t("common", K.thread.reply)}
        size="sm"
        value={internal ? "note" : "reply"}
        onChange={(v) => setInternal(v === "note")}
        options={[
          { value: "reply", label: t("common", K.thread.reply), icon: Send },
          { value: "note", label: t("common", K.thread.note), icon: StickyNote },
        ]}
      />
      <Textarea
        ref={box}
        dir="auto"
        rows={3}
        className="resize-none"
        placeholder={t("common", internal ? K.thread.notePlaceholder : K.thread.replyPlaceholder)}
        value={body}
        maxLength={SUPPORT_BODY_MAX}
        onChange={(e) => typed(e.target.value)}
        onKeyDown={(e) => {
          if (!isSendKey({ ...e, isComposing: e.nativeEvent.isComposing })) return;
          e.preventDefault();
          void submit();
        }}
      />
      {failure && <Alert tone="error">{failure}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {!internal && canned !== null ? (
          canned.length > 0 ? (
            <select
              aria-label={t("common", K.thread.canned)}
              className="max-w-[16rem] rounded-lg border border-card-border bg-bg-inner px-2 py-1 text-xs text-text-primary"
              value=""
              onChange={(e) => void insert(e.target.value)}
            >
              <option value="">{t("common", K.thread.canned)}</option>
              {canned.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.key} — {c.body.slice(0, 50)}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-2xs text-text-secondary">{t("common", K.thread.cannedNone)}</span>
          )
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {!internal && claims && <span className="text-2xs text-text-secondary">{t("common", K.thread.replyClaims)}</span>}
          <SendButton label={t("common", internal ? K.thread.sendNote : K.thread.send)} busy={busy} disabled={!body.trim()} />
        </div>
      </div>
    </form>
  );
}

/** The user, as billing sees them (F-033-m). `billing: null` is billing not answering — a line, never an error. */
function Sidebar({ id }: { id: string }) {
  const { lang, t } = useLocale();
  const [context, setContext] = useState<Awaited<ReturnType<typeof supportAgentApi.context>> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    supportAgentApi
      .context(id)
      .then((c) => alive && setContext(c))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [id]);

  const S = K.sidebar;
  const money = (amount: string, currency: string) => formatMoney(amount, currency, { lang, t });
  const billing = context?.billing ?? null;
  const links = context ? userLinksOf(context.userId) : null;

  return (
    <aside className="h-fit space-y-4 rounded-2xl border border-card-border bg-card-bg p-4 text-xs">
      <h2 className="text-sm font-bold text-text-primary">{t("common", S.title)}</h2>
      {context && (
        <div className="space-y-1">
          {/* F-033-r: the person by name, and one click to their page — services and details. */}
          {context.user && (
            <p dir="auto" className="text-sm font-bold text-text-primary">
              {context.user.fullName || context.user.username}
              {context.user.username && context.user.fullName && (
                <span dir="ltr" className="ms-1 font-normal text-text-secondary">
                  @{context.user.username}
                </span>
              )}
            </p>
          )}
          <p className="break-all text-text-secondary">
            {t("common", S.userId)}: <span className="font-mono text-text-primary">{context.userId}</span>
          </p>
          <Link href={links?.page ?? ""} className={buttonClass({ variant: "quiet", size: "sm" })}>
            <ExternalLink size={12} aria-hidden />
            {t("common", S.openUser)}
          </Link>
        </div>
      )}
      {/* BAN-1-f: restrict, ban and lift, by the caller's own keys (ADR-0133). */}
      {context && <UserStatusControl userId={context.userId} />}
      {failed || (context && !billing) ? (
        <p className="text-text-secondary">{t("common", S.unavailable)}</p>
      ) : !billing ? (
        <TableSkeleton rows={3} columns={1} withPagination={false} />
      ) : (
        <>
          <section className="space-y-1">
            <h3 className="font-bold text-text-primary">{t("common", S.wallet)}</h3>
            {billing.wallet ? (
              <>
                <p className="text-text-primary">{money(billing.wallet.balance, billing.wallet.currencyCode)}</p>
                {Number(billing.wallet.held) !== 0 && (
                  <p className="text-text-secondary">{t("common", S.held, { amount: money(billing.wallet.held, billing.wallet.currencyCode) })}</p>
                )}
              </>
            ) : (
              <p className="text-text-secondary">{t("common", S.noWallet)}</p>
            )}
          </section>

          <section className="space-y-1">
            <h3 className="font-bold text-text-primary">{t("common", S.grants)}</h3>
            {billing.grants.items.length === 0 ? (
              <p className="text-text-secondary">{t("common", S.noGrants)}</p>
            ) : (
              <ul className="space-y-2">
                {billing.grants.items.map((g) => (
                  <li key={g.id} className="space-y-0.5 rounded-lg bg-bg-inner p-2">
                    <p dir="auto" className="font-bold text-text-primary">
                      <Link
                        href={links?.grant(g.id) ?? ""}
                        title={t("common", S.openService)}
                        className="text-primary hover:underline"
                      >
                        {g.label ?? g.nameKey ?? g.id.slice(0, 8)}
                      </Link>
                      {g.frozen && <span className="ms-1 font-normal text-error">({t("common", S.frozen)})</span>}
                    </p>
                    <p className="text-text-secondary">
                      {g.trafficUnlimited
                        ? t("common", S.unlimited)
                        : t("common", S.used, { used: formatBytes(g.consumedBytes, lang) ?? "0", total: formatBytes(g.trafficCapBytes ?? g.purchasedBytes, lang) ?? "—" })}
                    </p>
                    {g.endsAt && <p className="text-text-secondary">{t("common", S.ends, { time: formatInstant(g.endsAt, lang) ?? "" })}</p>}
                  </li>
                ))}
              </ul>
            )}
            {billing.grants.hidden > 0 && <p className="text-text-secondary">{t("common", S.hiddenGrants, { n: billing.grants.hidden })}</p>}
          </section>

          <section className="space-y-1">
            <h3 className="font-bold text-text-primary">{t("common", S.invoices)}</h3>
            {billing.invoices.length === 0 ? (
              <p className="text-text-secondary">{t("common", S.noInvoices)}</p>
            ) : (
              <ul className="space-y-1">
                {billing.invoices.map((i) => (
                  <li key={i.id} className="flex justify-between gap-2">
                    <span className="text-text-secondary">{formatInstant(i.createdAt, lang, { withTime: false })}</span>
                    <span className="text-text-primary">{money(i.total, i.currencyCode)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-1">
            <h3 className="font-bold text-text-primary">{t("common", S.lastConnection)}</h3>
            <p className="text-text-secondary">{billing.lastConnectionAt ? formatInstant(billing.lastConnectionAt, lang) : t("common", S.never)}</p>
          </section>
        </>
      )}
    </aside>
  );
}
