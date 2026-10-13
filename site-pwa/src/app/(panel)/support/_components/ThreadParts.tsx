"use client";

import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, FileText, Send, Star } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE, fadeRise } from "@/lib/motion";
import { displayZone } from "@/lib/time-zone";
import type { SupportAttachment, SupportMessage } from "@/lib/support-api";
import { formatInstant } from "../../_lib/datetime";
import { Button, Dialog, Tooltip, cn } from "../../_components/kit";
import { SCAN_KEYS, SUPPORT_KEYS as K, awayFromBottom, fileSize, threadItems } from "../_lib/support";
import { dayIn } from "../../_lib/datetime";

/**
 * What the user's thread and the agent's share (UX-1-x, `contract.ux.md` T4):
 * the message list with its days and groups, the latest-message button, the
 * typing dots, image thumbnails, the growing composer, the send button and
 * the stars.
 */

// ------------------------------------------------------------ the list

/**
 * Messages under their day separators, each entering with `fadeRise`; the
 * first page lands without it. `render` draws one message, told whether it
 * opens a group (and so carries its sender's label).
 */
export function ThreadMessages<M extends SupportMessage>({
  messages,
  senderOf,
  render,
}: {
  messages: readonly M[];
  senderOf: (m: M) => string;
  render: (m: M, first: boolean) => ReactNode;
}) {
  const { lang } = useLocale();
  const level = useMotionLevel();
  const zone = displayZone();
  // "Today" as of when the thread was opened: a page left open past midnight says the date instead, which is still true.
  const [now] = useState(() => Date.now());
  const today = dayIn(now, zone);
  const yesterday = dayIn(now - 86_400_000, zone);
  const items = threadItems(messages, senderOf, zone);
  return (
    <ol className="space-y-1">
      <AnimatePresence initial={false}>
        {items.map((item) =>
          item.kind === "day" ? (
            <DaySeparator key={`day-${item.day}`} day={item.day} at={item.at} today={today} yesterday={yesterday} lang={lang} />
          ) : (
            <motion.li
              key={item.message.seq}
              variants={fadeRise(level)}
              initial="hidden"
              animate="shown"
              className={item.first ? "pt-2" : undefined}
            >
              {render(item.message, item.first)}
            </motion.li>
          ),
        )}
      </AnimatePresence>
    </ol>
  );
}

function DaySeparator({ day, at, today, yesterday, lang }: { day: string; at: string; today: string; yesterday: string; lang: string }) {
  const { t } = useLocale();
  const label = day === today ? t("common", K.thread.today) : day === yesterday ? t("common", K.thread.yesterday) : formatInstant(at, lang, { withTime: false });
  return (
    <li role="separator" aria-label={label ?? undefined} className="flex items-center gap-3 py-2">
      <span className="h-px flex-1 bg-card-border" aria-hidden />
      <span className="rounded-full bg-bg-inner px-3 py-0.5 text-2xs font-bold text-text-secondary">{label}</span>
      <span className="h-px flex-1 bg-card-border" aria-hidden />
    </li>
  );
}

// ------------------------------------------------------- the latest message

export interface FollowLatest {
  away: boolean;
  /** Messages that arrived while away. */
  missed: number;
  onScroll: () => void;
  jump: () => void;
}

/**
 * Near the bottom, a new message scrolls into view; away from it by more
 * than 200px it waits, counted, behind `JumpToLatest` (T4). The caller's own
 * message (`mineLast`) always scrolls — they just sent it.
 */
export function useFollowLatest(ref: RefObject<HTMLElement | null>, count: number, mineLast: boolean): FollowLatest {
  const [away, setAway] = useState(false);
  // How many there were the last time the bottom was in view — adjusted while rendering, not in an effect.
  const [tracked, setTracked] = useState({ count, seen: count });
  if (tracked.count !== count) setTracked({ count, seen: !away || mineLast ? count : tracked.seen });

  useEffect(() => {
    const el = ref.current;
    if (!el || (away && !mineLast)) return;
    el.scrollTo?.({ top: el.scrollHeight });
    // `away` is read when the count moves, not followed: scrolling decides it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, mineLast, ref]);

  return {
    away,
    missed: away ? Math.max(0, count - tracked.seen) : 0,
    onScroll: () => {
      const el = ref.current;
      if (!el) return;
      const now = awayFromBottom(el);
      setAway(now);
      if (!now) setTracked({ count, seen: count });
    },
    jump: () => {
      const el = ref.current;
      el?.scrollTo?.({ top: el.scrollHeight, behavior: "smooth" });
      setAway(false);
      setTracked({ count, seen: count });
    },
  };
}

export function JumpToLatest({ follow }: { follow: FollowLatest }) {
  const { t } = useLocale();
  const level = useMotionLevel();
  return (
    <AnimatePresence>
      {follow.away && (
        <motion.button
          type="button"
          onClick={follow.jump}
          aria-label={t("common", K.thread.jumpLatest)}
          initial={level === "reduced" ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: level === "reduced" ? DURATION.fast : DURATION.base, ease: EASE.standard }}
          className="absolute bottom-3 end-3 z-10 flex items-center gap-1 rounded-full border border-card-border bg-card-bg px-3 py-1.5 text-xs font-bold text-text-primary shadow-lg hover:bg-bg-inner"
        >
          <ArrowDown size={14} aria-hidden />
          {follow.missed > 0 && <span className="text-primary">{t("common", K.thread.jumpNew, { n: follow.missed })}</span>}
        </motion.button>
      )}
    </AnimatePresence>
  );
}

// ------------------------------------------------------------- typing

/** The other side is typing: three dots that bounce in turn — held still under reduced motion (M3) — named for a screen reader. */
export function TypingDots({ label }: { label: string }) {
  const level = useMotionLevel();
  return (
    <span role="status" aria-label={label} className="inline-flex items-center gap-1 rounded-2xl bg-bg-inner px-3 py-2.5">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          data-dot
          aria-hidden
          className="size-1.5 rounded-full bg-text-secondary"
          animate={level === "reduced" ? undefined : { y: [0, -4, 0], opacity: [0.5, 1, 0.5] }}
          transition={level === "reduced" ? undefined : { duration: 0.9, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------- attachments

const isImage = (a: SupportAttachment) => a.url !== null && !a.expired && a.contentType.startsWith("image/");

/** A message's files: clean images as 160px thumbnails, everything else as a row. */
export function AttachmentList({ attachments }: { attachments: readonly SupportAttachment[] }) {
  if (attachments.length === 0) return null;
  const images = attachments.filter(isImage);
  const rest = attachments.filter((a) => !isImage(a));
  return (
    <div className="space-y-1">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((a) => (
            <ThreadImage key={a.id} attachment={a} />
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <ul className="space-y-1">
          {rest.map((a) => (
            <AttachmentRow key={a.id} attachment={a} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ThreadImage({ attachment: a }: { attachment: SupportAttachment }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${t("common", K.thread.imageOpen)}: ${a.fileName}`}
        className="overflow-hidden rounded-xl border border-card-border transition-transform hover:scale-[1.02] motion-reduce:hover:scale-100"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a signed five-minute URL, not something next/image may cache */}
        <img src={a.url ?? undefined} alt={a.fileName} loading="lazy" className="size-40 object-cover" />
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={<span dir="auto">{a.fileName}</span>} size="lg">
        {/* eslint-disable-next-line @next/next/no-img-element -- as above */}
        <img src={a.url ?? undefined} alt={a.fileName} className="mx-auto max-h-[70vh] w-auto rounded-xl object-contain" />
      </Dialog>
    </>
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

// ------------------------------------------------------------ composer

const GROW_MAX_PX = 240;

/** The composer grows with its text up to 240px, then scrolls (T4). */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, GROW_MAX_PX)}px`;
    el.style.overflowY = el.scrollHeight > GROW_MAX_PX ? "auto" : "hidden";
  }, [ref, value]);
}

const onMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Send, with a tooltip naming the shortcut — ⌘ on a Mac, Ctrl elsewhere. */
export function SendButton({ label, busy, disabled }: { label: string; busy: boolean; disabled: boolean }) {
  const { t } = useLocale();
  return (
    <Tooltip content={t("common", onMac() ? K.thread.sendShortcutMac : K.thread.sendShortcut)}>
      <Button type="submit" loading={busy} disabled={disabled} icon={<Send size={16} className="rtl:-scale-x-100" aria-hidden />}>
        {label}
      </Button>
    </Tooltip>
  );
}

// -------------------------------------------------------------- rating

/** Five stars that fill up to the one chosen, each popping as it fills (T4). */
export function StarRating({ value, onChange, label, starLabel }: { value: number; onChange: (n: number) => void; label: string; starLabel: (n: number) => string }) {
  const level = useMotionLevel();
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <div className="flex gap-1" role="radiogroup" aria-label={label} onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <motion.button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={starLabel(n)}
          onClick={() => onChange(n)}
          onMouseEnter={() => setHover(n)}
          whileTap={level === "reduced" ? undefined : { scale: 0.85 }}
          className="rounded-lg p-0.5"
        >
          <motion.span
            className="block"
            animate={level === "reduced" ? undefined : { scale: n <= value ? [1, 1.3, 1] : 1 }}
            transition={{ duration: DURATION.slow, delay: level === "reduced" ? 0 : (n - 1) * 0.04, ease: EASE.standard }}
          >
            <Star size={24} className={cn("transition-colors", n <= shown ? "fill-primary text-primary" : "text-text-secondary")} aria-hidden />
          </motion.span>
        </motion.button>
      ))}
    </div>
  );
}
