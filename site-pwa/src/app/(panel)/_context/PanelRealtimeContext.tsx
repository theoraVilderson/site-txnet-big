"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { authApi } from "@/lib/auth-api";
import { AUTH_LOGIN } from "@/lib/routes";
import { createRealtimeClient, type RealtimeClient } from "@/lib/realtime";
import { usePanelSession } from "./PanelSessionContext";

type PanelRealtime = {
  /**
   * The socket this signed-in session holds, or `null` while there is none —
   * before the session is established, and on a deployment with no gateway
   * configured. A consumer subscribes when it is not null and lets its effect
   * re-run when it changes.
   */
  client: RealtimeClient | null;
};

const PanelRealtimeContext = createContext<PanelRealtime | null>(null);

/**
 * One WebSocket for the whole signed-in session (`F-070-c`).
 *
 * It sits at the panel layout rather than in a page, because that is what
 * makes it survive navigation: everything under `(panel)` is one mount, so
 * moving between screens does not cost a reconnect. The rules it obeys are in
 * `docs/interfaces/panel-web/contract.realtime.md`; the transport itself is
 * `lib/realtime.ts` and this file adds no frames of its own.
 *
 * **It is deliberately not the OTP screen's socket** (F-070-b). That one is
 * anonymous, lives for the length of one delivery and dies with the step. This
 * one is authenticated by `forward-auth` like every other request, so its
 * credential is the access token — and that is the whole difficulty, because
 * the token this provider offers and the one the page holds are the same
 * rotating value (F-0209).
 *
 * Three seams, in the order they bite:
 *
 * 1. **It opens only once there is an account.** `PanelSessionContext` trades
 *    the refresh cookie for a token once per page load; a socket opened before
 *    that lands is an *anonymous* connection, which is refused every `user:`
 *    channel by construction and reports nothing (`realtime/contract.channels.md`).
 * 2. **A change of account is a close-and-reopen.** The gate decides identity
 *    at the upgrade (ADR-0030), so there is no frame that turns one user's
 *    connection into another's. `AccountSwitcher` already throws the whole
 *    document away, which achieves the same thing — but that is its choice,
 *    not a rule, and this keying is what makes it one.
 * 3. **`4401` is this panel's no-session redirect**, and never a reconnect.
 *    The gateway re-reads `session:<id>` on an interval and closes with it when
 *    the marker is gone, which is a sign-out that happened elsewhere.
 */
export function PanelRealtimeProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { group } = usePanelSession();
  const userId = group?.current.userId ?? null;
  const [client, setClient] = useState<RealtimeClient | null>(null);

  // The socket's lifetime is keyed to the account and to nothing else, so the
  // effect below must not list anything that changes per render — `useRouter()`
  // hands back a fresh object each time, and depending on it would tear the
  // connection down and build it again on every re-render.
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    if (!userId) return;
    let alive = true;

    const socket = createRealtimeClient({
      // Read on every connect, never captured: refresh rotates the token, and
      // a reconnect offering the one this effect started with is refused as a
      // `401` no browser can see.
      credential: () => authApi.getAccessToken(),
      onSessionLost: () => {
        if (alive) routerRef.current.replace(AUTH_LOGIN);
      },
      onCredentialRejected: () => {
        // The upgrade was refused before a socket existed. The client has
        // already stopped and will retry with backoff, so all this owes it is
        // a live token — `refresh()` and not `ensureSession()`, which is
        // memoised per page load and would hand back the same dead one.
        authApi.refresh().catch(() => {
          // No cookie either. Retrying would ask a question already answered.
          if (!alive) return;
          socket.close();
          routerRef.current.replace(AUTH_LOGIN);
        });
      },
    });

    setClient(socket);
    socket.connect();

    return () => {
      alive = false;
      socket.close();
      setClient(null);
    };
  }, [userId]);

  const value = useMemo(() => ({ client }), [client]);

  return (
    <PanelRealtimeContext.Provider value={value}>
      {children}
    </PanelRealtimeContext.Provider>
  );
}

/**
 * The panel's socket, or `null` when there is none to hold yet. Throws outside
 * the provider, so a component mounted in the wrong tree is told rather than
 * quietly never receiving anything.
 */
export function usePanelRealtime(): RealtimeClient | null {
  const ctx = useContext(PanelRealtimeContext);
  if (!ctx)
    throw new Error(
      "usePanelRealtime must be used within PanelRealtimeProvider",
    );
  return ctx.client;
}
