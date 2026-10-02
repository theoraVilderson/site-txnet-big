"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { authApi, type Me, type SwitchGroup } from "@/lib/auth-api";
import { browserReport, browserZone, setDisplayZone, type ResolvedTimeZone } from "@/lib/time-zone";
import { miniAppHost } from "@/lib/mini-app";
import { AUTH_LOGIN } from "@/lib/routes";
import { currentReturnPath, rememberReturnTo } from "@/lib/return-to";

type PanelSession = {
  /** null while the session is still being established. */
  group: SwitchGroup | null;
  /**
   * Who the caller is and what it may do (F-097) — null while loading, and null
   * if `GET /auth/me` failed. A failed `me` is **not** a missing session: the
   * panel stays, and every permission-gated surface stays hidden, which is the
   * safe direction to be wrong in.
   */
  me: Me | null;
  isLoading: boolean;
  /**
   * The zone this caller's dates are drawn in (TZ-1-e, ADR-0108) — null until
   * read, or when the read failed (dates then use the browser's own clock).
   */
  timeZone: ResolvedTimeZone | null;
  /** After the caller changed their zone, or their tenant's: dates follow the new answer. */
  zoneChanged: (resolved: ResolvedTimeZone) => void;
  /** Re-read the group — after adding an account, or after a switch. */
  reload: () => Promise<void>;
};

const PanelSessionContext = createContext<PanelSession | null>(null);

/**
 * Who this browser is signed in as, and which accounts it may become (F-0209).
 *
 * The panel needs an access token before it can ask anything, and the token is
 * held in memory by `lib/auth-api` — so a reload starts with none. This turns
 * the httpOnly refresh cookie back into one (`ensureSession`), then reads the
 * switch group.
 *
 * No live session means the visitor does not belong on the panel at all, so
 * they are sent to the login screen. That is the mirror of `src/proxy.ts`,
 * which sends a signed-in visitor away from the login screen (F-0101): the two
 * together are what makes "one browser, one account" visible to the user.
 *
 * **Inside a Mini App there is one more thing to ask first** (F-310, ADR-0017).
 * A messenger's webview starts with no cookie, so the cookie's absence is not
 * evidence of anything there — the host is holding a signature that says who
 * is looking. Asking it is the difference between the panel opening straight
 * into the user's account and the panel opening on a login screen inside a
 * messenger that already knows who they are. It is only ever asked *after* the
 * cookie fails, so a webview that is already signed in costs nothing extra.
 */
export function PanelSessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [group, setGroup] = useState<SwitchGroup | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [timeZone, setTimeZone] = useState<ResolvedTimeZone | null>(null);

  const zoneChanged = useCallback((resolved: ResolvedTimeZone) => {
    setDisplayZone(resolved.zone);
    setTimeZone(resolved);
  }, []);

  // ADR-0043: a call refused because this user's permissions changed has
  // already refreshed the token by the time this runs; `me` was read from the
  // old one, so the menu would otherwise keep offering what the gate now refuses.
  useEffect(
    () =>
      authApi.onPermissionsRefreshed(() => {
        void readMe().then(setMe);
      }),
    [],
  );

  // A switch changes who the caller is, so `me` is re-read with the group.
  const reload = useCallback(async () => {
    const [next, who] = await Promise.all([authApi.listAccounts(), readMe()]);
    setGroup(next);
    setMe(who);
    void syncTimeZone().then((resolved) => resolved && zoneChanged(resolved));
  }, [zoneChanged]);

  // Before any child's `useEffect`: a sidebar entry fetching on mount waits for
  // the session below instead of going out tokenless (`authApi.holdUntilSession`).
  // No cleanup releases it: StrictMode's simulated unmount would free a call the
  // first mount held, tokenless. The `finally` below runs past an unmount anyway.
  useLayoutEffect(() => {
    authApi.holdUntilSession();
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        try {
          await establishSession();
        } finally {
          authApi.releaseSessionHold();
        }
        const [next, who] = await Promise.all([
          authApi.listAccounts(),
          readMe(),
        ]);
        if (alive) {
          setGroup(next);
          setMe(who);
        }
        // After sign-in, not before: a page's own calls are not held for it.
        void syncTimeZone().then((resolved) => alive && resolved && zoneChanged(resolved));
      } catch {
        // Expired, revoked, or never signed in — all one answer. `replace`, so
        // the panel is not reachable with Back.
        //
        // Where they were going is remembered first (F-093-i, ADR-0042): this
        // is the one place the panel discovers it has no session, so it is the
        // one place that still knows the destination. The login screen hands it
        // back; a path that is not this origin's is dropped there and here.
        rememberReturnTo(currentReturnPath());
        router.replace(AUTH_LOGIN);
      } finally {
        if (alive) setIsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [router, zoneChanged]);

  return (
    <PanelSessionContext.Provider value={{ group, me, isLoading, timeZone, zoneChanged, reload }}>
      {children}
    </PanelSessionContext.Provider>
  );
}

/**
 * The session this page load runs on: the refresh cookie if there is one, and
 * otherwise the messenger's own signature when the page is a Mini App.
 *
 * Throws when neither answers, which is the single failure the caller acts on.
 * A `needsContact` answer throws for the same reason a missing cookie does —
 * the number was never shared with the bot, so the ordinary login screen is
 * exactly the right next screen, and the chat is where that gap is closed.
 */
async function establishSession() {
  try {
    return await authApi.ensureSession();
  } catch (cookieFailure) {
    const host = await miniAppHost();
    if (!host) throw cookieFailure;
    host.ready();
    const result = await authApi.webAppSession(host.platform, host.initData);
    if (result.state !== "authenticated") throw cookieFailure;
    return result;
  }
}

/**
 * Read the caller's zone and, when it is not their own choice, report this
 * browser's (TZ-1-e, ADR-0108 point 4) — the only automatic source. The server
 * holds the rule too: a report never lands over a choice, even one saved
 * between this read and the write. Null when either call failed — never a
 * reason to leave the panel, and dates then use the browser's clock.
 */
async function syncTimeZone(): Promise<ResolvedTimeZone | null> {
  try {
    const stored = await authApi.timeZone();
    const report = browserReport(stored, browserZone());
    if (!report) return stored.resolved;
    return (await authApi.saveTimeZone(report.zone, report.source)).resolved;
  } catch {
    return null;
  }
}

/** `me`, or null — never a reason to leave the panel (see `PanelSession.me`). */
async function readMe(): Promise<Me | null> {
  try {
    return await authApi.me();
  } catch {
    return null;
  }
}

export function usePanelSession() {
  const ctx = useContext(PanelSessionContext);
  if (!ctx)
    throw new Error("usePanelSession must be used within PanelSessionProvider");
  return ctx;
}
