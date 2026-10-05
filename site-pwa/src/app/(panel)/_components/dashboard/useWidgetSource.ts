"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { ApiError } from "@/lib/api-error";
import { usePanelSession } from "../../_context/PanelSessionContext";

interface DashboardState {
  /** Widgets a source refused with 403, by user: hidden for the rest of this page's life (D5). */
  forbidden: Record<string, true>;
  forbid: (key: string) => void;
}

export const useDashboardStore = create<DashboardState>((set) => ({
  forbidden: {},
  forbid: (key) => set((s) => ({ forbidden: { ...s.forbidden, [key]: true } })),
}));

/** The key a refusal is kept under — another user's 403 is not this one's. */
export const forbiddenKey = (userId: string | null, widgetId: string) => `${userId ?? ""}:${widgetId}`;

export type WidgetSource<T> =
  | { state: "loading"; retry: () => void }
  | { state: "error"; retry: () => void }
  | { state: "ready"; data: T; retry: () => void };

/**
 * One widget's read (UX-1-p, D1): loading, failed with a retry, or its data. A
 * 403 hides the widget for the session instead (D5) — the caller holds the
 * permission the registry asked for, but the source's own door said no, and a
 * card that can only ever say "failed" is noise. `ask` is read on every run,
 * so a widget may pass an inline function; `deps` say when to ask again.
 */
export function useWidgetSource<T>(widgetId: string, ask: () => Promise<T>, deps: readonly unknown[] = []): WidgetSource<T> {
  const { group } = usePanelSession();
  const userId = group?.current.userId ?? null;
  const forbid = useDashboardStore((s) => s.forbid);
  const [asked, setAsked] = useState(0);
  const retry = useCallback(() => setAsked((n) => n + 1), []);
  // One ask per key: an answer for an older key reads as loading, never as this one's.
  const key = JSON.stringify([widgetId, userId, asked, ...deps]);
  const [answer, setAnswer] = useState<{ key: string; state: "error" } | { key: string; state: "ready"; data: T } | null>(null);
  const askRef = useRef(ask);
  useEffect(() => {
    askRef.current = ask;
  });

  useEffect(() => {
    let live = true;
    askRef.current().then(
      (data) => live && setAnswer({ key, state: "ready", data }),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 403) forbid(forbiddenKey(userId, widgetId));
        setAnswer({ key, state: "error" });
      },
    );
    return () => {
      live = false;
    };
  }, [key, widgetId, userId, forbid]);

  if (answer === null || answer.key !== key) return { state: "loading", retry };
  return answer.state === "ready" ? { state: "ready", data: answer.data, retry } : { state: "error", retry };
}
