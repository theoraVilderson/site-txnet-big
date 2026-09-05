"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authApi, type BotLinkRequired, type BotLinkStatus } from "@/lib/auth-api";

const POLL_INTERVAL_MS = 2500;

/**
 * Drives the "open the bot and share your number" step.
 *
 * The code for a messenger channel is delivered *by the bot*, after the user
 * proves the number is theirs there — so nothing arrives on this screen to
 * react to. It polls the link's status instead, and calls `onLinked` once the
 * server says the account is connected (and, normally, that the code went out).
 */
export function useBotLink(onLinked: (status: BotLinkStatus) => void) {
  const [link, setLink] = useState<BotLinkRequired | null>(null);
  const [status, setStatus] = useState<BotLinkStatus | null>(null);
  // The ref is written after commit, never during render (react-hooks/refs).
  // It is only ever read from the poll timer, which cannot fire before the
  // first commit, so it is always the current callback.
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

    const tick = async () => {
      try {
        const next = await authApi.botLinkStatus(link.linkToken);
        if (!alive) return;
        setStatus(next);
        if (next.state === "linked") {
          window.clearInterval(timer);
          onLinkedRef.current(next);
        }
      } catch {
        // A failed poll is not a failed link — keep waiting; the user is in
        // another app and the next tick is 2.5s away.
      }
    };

    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    void tick();
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [link]);

  return { link, status, start: setLink, reset };
}
