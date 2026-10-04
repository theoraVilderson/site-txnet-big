"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { supportAgentApi } from "@/lib/support-api";
import { PRESENCE_EVERY_MS } from "../_lib/support-agent";

/** Per browser, a convenience only: support's own record is the heartbeat. */
const STORAGE_KEY = "txnet.support.presence";

function stored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "away";
  } catch {
    return true;
  }
}

function remember(online: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, online ? "online" : "away");
  } catch {
    // Private mode: the choice lasts this page only.
  }
  overridden = online;
  for (const l of listeners) l();
}

/** The choice as this page last set it, for a browser that would not store it. */
let overridden: boolean | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const snapshot = () => overridden ?? stored();

/**
 * The agent's presence (F-033-g) while an inbox page is open: a beat every
 * 30s, forgotten by support 90s after the last — so moving between the inbox
 * and a thread never flaps, and a closed tab goes offline by itself. "Go
 * offline" says `away` at once and stops beating.
 */
export function usePresence(): { online: boolean; toggle: () => void } {
  // Online on the server's render; the stored choice once in the browser.
  const online = useSyncExternalStore(subscribe, snapshot, () => true);

  useEffect(() => {
    if (!online) return;
    const beat = () => void supportAgentApi.presence("online").catch(() => undefined);
    beat();
    const timer = setInterval(beat, PRESENCE_EVERY_MS);
    return () => clearInterval(timer);
  }, [online]);

  const toggle = useCallback(() => {
    const next = !snapshot();
    remember(next);
    if (!next) void supportAgentApi.presence("away").catch(() => undefined);
  }, []);

  return { online, toggle };
}
