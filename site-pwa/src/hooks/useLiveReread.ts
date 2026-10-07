"use client";

import { useEffect, useRef } from "react";
import { usePanelRealtime } from "@/app/(panel)/_context/PanelRealtimeContext";
import { LIVE_REREAD_MS } from "@/lib/realtime";

/** Why a read was owed: an event on the channel, or a reconnect that may have missed some. */
export type LiveRereadCause = "event" | "missed";

/**
 * The one way a page re-reads on a live event (RT-1-a, ADR-0121,
 * `realtime/contract.live-events.md`). The event's body is never rendered: it
 * says *that* something changed, and the page asks its own API *what*.
 *
 * - Subscribes to `channel` on the panel's socket, and to nothing while either
 *   is null.
 * - Re-reads on a message whose `type` is in `types` (`"any"`: every message on
 *   the channel), and on `onMissed` — an event sent while the socket was down
 *   reached nobody.
 * - Throttled (F-067-p): the first event reads at once, the rest of a
 *   {@link LIVE_REREAD_MS} window owes one more read at its end. A window that
 *   held an event reads as `"event"` though a reconnect came last.
 * - `reread` is held in a ref, so a caller need not memoize it and changing it
 *   never resubscribes — a channel dropped and re-declared is a window where an
 *   event is lost.
 */
export function useLiveReread(
  channel: string | null,
  types: readonly string[] | "any",
  reread: (cause: LiveRereadCause) => void,
): void {
  const client = usePanelRealtime();

  const rereadRef = useRef(reread);
  const typesRef = useRef(types);
  useEffect(() => {
    rereadRef.current = reread;
    typesRef.current = types;
  });

  useEffect(() => {
    if (!client || !channel) return;
    let last = -Infinity;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let owed: LiveRereadCause | null = null;

    const run = () => {
      timer = null;
      last = Date.now();
      const cause = owed ?? "event";
      owed = null;
      rereadRef.current(cause);
    };
    const call = (cause: LiveRereadCause) => {
      if (owed !== "event") owed = cause;
      if (timer) return;
      const wait = last + LIVE_REREAD_MS - Date.now();
      if (wait <= 0) run();
      else timer = setTimeout(run, wait);
    };

    const unsubscribe = client.subscribe(channel, {
      onMessage: (payload) => {
        if (!payload || typeof payload !== "object") return;
        const listed = typesRef.current;
        const type = (payload as Record<string, unknown>).type;
        if (listed === "any" || (typeof type === "string" && listed.includes(type))) call("event");
      },
      onMissed: () => call("missed"),
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [client, channel]);
}
