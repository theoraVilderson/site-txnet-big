"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { activityOf, agoOf, nextChangeIn, type ActivityState } from "../_lib/pulse";
import { formatBytes } from "../_lib/service-configs";

const P = FrontendI18nKeys.common.myServices.pulse;
const A = FrontendI18nKeys.common.myServices.ago;

/** How long a push's "+45 MB" stays up. */
const BUMP_MS = 4000;

export interface Pulse {
  state: ActivityState;
  /** How long ago traffic last moved; `null` when it never has. */
  idleMs: number | null;
  /** What the latest push added, while it shows; `n` restarts its animation. */
  bump: { bytes: string; n: number } | null;
}

/**
 * Whether a Grant is moving data (F-307-u), recounted in the browser — no
 * read. The clock wakes at each edge (live → cooling → idle), then on each
 * whole minute of idleness so "last used 3 min ago" turns when it should. A new
 * stamp (a push, via `useGrantsPage`) restarts it from now, and a rise in
 * `consumedBytes` is shown as what the push added.
 */
export function useServicePulse(lastTrafficAt: string | null, consumedBytes: string): Pulse {
  const [now, setNow] = useState(() => new Date());
  const [seenStamp, setSeenStamp] = useState(lastTrafficAt);
  const [seenBytes, setSeenBytes] = useState(consumedBytes);
  const [bump, setBump] = useState<Pulse["bump"]>(null);

  // Adjusted while rendering, not in an effect, so the push's render is
  // already live and already shows what it added.
  let at = now;
  if (lastTrafficAt !== seenStamp) {
    setSeenStamp(lastTrafficAt);
    at = new Date();
    setNow(at);
  }
  if (consumedBytes !== seenBytes) {
    setSeenBytes(consumedBytes);
    const added = rise(seenBytes, consumedBytes);
    if (added !== null) setBump({ bytes: added, n: (bump?.n ?? 0) + 1 });
  }

  const { state, idleMs } = activityOf(lastTrafficAt, at);

  useEffect(() => {
    const wait = nextChangeIn(state, idleMs);
    if (wait === null) return;
    const timer = setTimeout(() => setNow(new Date()), wait);
    return () => clearTimeout(timer);
  }, [state, idleMs]);

  useEffect(() => {
    if (!bump) return;
    const timer = setTimeout(() => setBump(null), BUMP_MS);
    return () => clearTimeout(timer);
  }, [bump]);

  return { state, idleMs, bump };
}

/** `after - before` as a decimal string when it is a rise; `null` otherwise. */
function rise(before: string, after: string): string | null {
  try {
    const d = BigInt(after) - BigInt(before);
    return d > BigInt(0) ? d.toString() : null;
  } catch {
    return null;
  }
}

/** Seconds since `lastTrafficAt`, recounted every second while `ticking` — the pulse's own clock, so the row does not redraw each second. */
function useSecondsSince(lastTrafficAt: string | null, ticking: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, lastTrafficAt]);
  if (!lastTrafficAt) return null;
  const at = new Date(lastTrafficAt).getTime();
  return Number.isNaN(at) ? null : Math.max(0, now - at);
}

/**
 * The line under a live service's name, in one of four honest states:
 *
 * - **live** — a beating dot, "in use", and the seconds since the last
 *   traffic counting up in the open, back to zero on each push: the user sees
 *   the figure arrive rather than trusting a light.
 * - **cooling** — the push traffic would have sent is late. The dot stops and
 *   the row says "no new traffic — probably stopped", never "in use" (user,
 *   2026-09-27: a stopped service must not read live).
 * - **idle** — a hollow dot and when it was last used.
 * - **never** — "not used yet".
 *
 * It says only what the panels saw; the caller leaves it out while metering
 * is down, when silence means nothing.
 */
export function ServicePulse({ pulse, lastTrafficAt }: { pulse: Pulse; lastTrafficAt: string | null }) {
  const { t, lang } = useLocale();
  const recent = pulse.state === "live" || pulse.state === "cooling";
  const since = useSecondsSince(lastTrafficAt, recent);
  const agoText = (ms: number | null) => {
    if (ms === null) return "";
    const ago = agoOf(ms);
    return ago.unit === "now" ? t("common", A.now) : t("common", A[ago.unit], { n: ago.n });
  };

  if (pulse.state === "live") {
    return (
      <p
        role="status"
        aria-label={t("common", P.live)}
        title={t("common", P.cadence)}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
      >
        <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:hidden" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
        </span>
        <span className="font-bold text-primary">{t("common", P.live)}</span>
        <span className="tabular-nums text-text-secondary">{t("common", P.liveHint, { ago: agoText(since) })}</span>
        {pulse.bump && (
          <span
            key={pulse.bump.n}
            title={t("common", P.added)}
            dir="ltr"
            className="pulse-bump rounded-full bg-leaf-bg px-2 py-0.5 font-bold text-primary"
          >
            +{formatBytes(pulse.bump.bytes, lang)}
          </span>
        )}
      </p>
    );
  }

  if (pulse.state === "cooling") {
    return (
      <p
        role="status"
        aria-label={t("common", P.cooling)}
        title={t("common", P.cadence)}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary"
      >
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary/40" aria-hidden />
        <span className="font-bold">{t("common", P.cooling)}</span>
        <span className="tabular-nums">{t("common", P.coolingHint, { ago: agoText(since) })}</span>
      </p>
    );
  }

  return (
    <p role="status" aria-label={t("common", P.idle)} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-text-secondary/50" aria-hidden />
      <span className="font-bold">{t("common", P.idle)}</span>
      <span>{pulse.idleMs === null ? t("common", P.never) : t("common", P.idleSince, { ago: agoText(pulse.idleMs) })}</span>
    </p>
  );
}
