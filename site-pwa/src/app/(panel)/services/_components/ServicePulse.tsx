"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { LIVE_WINDOW_MS, activityOf, agoOf } from "../_lib/pulse";
import { formatBytes } from "../_lib/service-configs";

const P = FrontendI18nKeys.common.myServices.pulse;
const A = FrontendI18nKeys.common.myServices.ago;

/** How long a push's "+45 MB" stays up. */
const BUMP_MS = 4000;

export interface Pulse {
  live: boolean;
  /** How long ago traffic last moved; `null` when it never has. */
  idleMs: number | null;
  /** What the latest push added, while it shows; `n` restarts its animation. */
  bump: { bytes: string; n: number } | null;
}

/**
 * Whether a Grant is moving data (F-307-u), recounted in the browser — no
 * read. The clock wakes once when the live window closes, then on each whole
 * minute of idleness so "last used 3 min ago" turns when it should. A new
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

  const { live, idleMs } = activityOf(lastTrafficAt, at);

  useEffect(() => {
    if (idleMs === null) return;
    const wait = live ? LIVE_WINDOW_MS - idleMs : 60_000 - (idleMs % 60_000);
    const timer = setTimeout(() => setNow(new Date()), wait);
    return () => clearTimeout(timer);
  }, [live, idleMs]);

  useEffect(() => {
    if (!bump) return;
    const timer = setTimeout(() => setBump(null), BUMP_MS);
    return () => clearTimeout(timer);
  }, [bump]);

  return { live, idleMs, bump };
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

/**
 * The line under a live service's name: a beating dot and "in use", or a
 * still one and when it was last used. It says only what the panels saw —
 * the caller leaves it out while metering is down, when silence means nothing.
 */
export function ServicePulse({ pulse }: { pulse: Pulse }) {
  const { t, lang } = useLocale();

  if (pulse.live) {
    return (
      <p role="status" aria-label={t("common", P.live)} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:hidden" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
        </span>
        <span className="font-bold text-primary">{t("common", P.live)}</span>
        <span className="text-text-secondary">{t("common", P.liveHint)}</span>
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

  const ago = pulse.idleMs === null ? null : agoOf(pulse.idleMs);
  return (
    <p role="status" aria-label={t("common", P.idle)} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-text-secondary/50" aria-hidden />
      <span className="font-bold">{t("common", P.idle)}</span>
      <span>
        {ago === null
          ? t("common", P.never)
          : t("common", P.idleSince, { ago: ago.unit === "now" ? t("common", A.now) : t("common", A[ago.unit], { n: ago.n }) })}
      </span>
    </p>
  );
}
