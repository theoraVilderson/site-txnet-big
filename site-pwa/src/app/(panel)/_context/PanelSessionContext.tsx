"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { authApi, type SwitchGroup } from "@/lib/auth-api";
import { AUTH_LOGIN } from "@/lib/routes";

type PanelSession = {
  /** null while the session is still being established. */
  group: SwitchGroup | null;
  isLoading: boolean;
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
 */
export function PanelSessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [group, setGroup] = useState<SwitchGroup | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    setGroup(await authApi.listAccounts());
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await authApi.ensureSession();
        const next = await authApi.listAccounts();
        if (alive) setGroup(next);
      } catch {
        // Expired, revoked, or never signed in — all one answer. `replace`, so
        // the panel is not reachable with Back.
        router.replace(AUTH_LOGIN);
      } finally {
        if (alive) setIsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [router]);

  return (
    <PanelSessionContext.Provider value={{ group, isLoading, reload }}>
      {children}
    </PanelSessionContext.Provider>
  );
}

export function usePanelSession() {
  const ctx = useContext(PanelSessionContext);
  if (!ctx)
    throw new Error("usePanelSession must be used within PanelSessionProvider");
  return ctx;
}
