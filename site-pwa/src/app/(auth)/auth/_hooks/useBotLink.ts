"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authApi, type BotLinkRequired, type BotLinkStatus } from "@/lib/auth-api";
import { createRealtimeClient } from "@/lib/realtime";

/**
 * Drives the "open the bot and share your number" step.
 *
 * The code for a messenger channel is delivered *by the bot*, after the user
 * proves the number is theirs there. The server pushes the link's outcome on
 * its `otp:` channel (RT-1-h) — anonymous, authorized by the proof the start
 * answer handed over, like `useOtpDelivery` — and this screen re-reads the
 * status route on each frame, after a missed window, and on mount; it never
 * trusts the frame itself. `onLinked` is called once the record says `linked`.
 */
export function useBotLink(onLinked: (status: BotLinkStatus) => void) {
  const [link, setLink] = useState<BotLinkRequired | null>(null);
  const [status, setStatus] = useState<BotLinkStatus | null>(null);
  // The ref is written after commit, never during render (react-hooks/refs).
  // It is only read from a status answer, which cannot land before the first
  // commit, so it is always the current callback.
  const onLinkedRef = useRef(onLinked);
  useEffect(() => {
    onLinkedRef.current = onLinked;
  });

  const reset = useCallback(() => {
    setLink(null);
    setStatus(null);
  }, []);

  useEffect(() => {
    if (!link) return;
    let alive = true;
    let linked = false;

    const read = async () => {
      try {
        const next = await authApi.botLinkStatus(link.linkToken);
        if (!alive || linked) return;
        setStatus(next);
        if (next.state === "linked") {
          linked = true;
          onLinkedRef.current(next);
        }
      } catch {
        // A failed read is not a failed link — keep waiting; the next frame,
        // or the reconnect after the user comes back from the messenger, reads again.
      }
    };

    const client = createRealtimeClient();
    const leave = client.subscribe(link.channel, {
      proof: link.channelToken,
      onMessage: () => void read(),
      onMissed: () => void read(),
      // An expired channel is the link's own expiry: the status route says so on the next read.
      onError: () => {},
    });
    client.connect();
    void read();

    return () => {
      alive = false;
      leave();
      client.close();
    };
  }, [link]);

  return { link, status, start: setLink, reset };
}
