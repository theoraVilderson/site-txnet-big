"use client";

import { useEffect, useState } from "react";
import { authApi, type Me } from "@/lib/auth-api";
import { RealtimeEvents } from "@/generated/wire";
import { userChannel } from "@/lib/realtime";
import { useLiveReread } from "@/hooks/useLiveReread";
import { activeHref } from "../_lib/panel-menu";
import { usePanelSession } from "../_context/PanelSessionContext";

/**
 * The person's access moved (AC-1-r): a role set or edited, a seat removed or
 * restored — `identity.access.changed` on their own channel (AC-1-q). The
 * token is refreshed once; F-101-c's `onPermissionsRefreshed` listener then
 * re-reads `me`, and the menu, buttons and page guards follow it. The event's
 * `cause` is never read here: the token says what is held now.
 *
 * A reconnect refreshes too — a change sent while the socket was down reached
 * nobody. A failed refresh is dropped: the next call's own 401 ends the
 * session the way any other does.
 */
export function useAccessLive(): void {
  const { group } = usePanelSession();
  const userId = group?.current.userId ?? null;
  useLiveReread(userId ? userChannel(userId) : null, [RealtimeEvents.accessChanged], () => {
    authApi.refreshAccess().catch(() => {});
  });
}

/**
 * Whether the open page was just taken away: its menu entry (the one
 * `activeHref` lights up) was in the caller's menu, and a new `me` came
 * without it. Only a `me` that replaced another counts — the first one of a
 * page load is the page's own guard's to answer, and a menu entry that comes
 * and goes on its own async read is not an access change. Clears when the
 * entry comes back or the path changes.
 */
export function useAccessLost(me: Me | null, hrefs: readonly string[], pathname: string): boolean {
  const owner = activeHref(hrefs, pathname);
  const listed = (href: string) => activeHref(hrefs, href) === href;
  const [seen, setSeen] = useState({ me, owner, pathname });
  const [lost, setLost] = useState<{ href: string; pathname: string } | null>(null);

  if (seen.me !== me || seen.owner !== owner || seen.pathname !== pathname) {
    if (seen.pathname === pathname && seen.me && me && seen.me !== me && seen.owner && !listed(seen.owner)) {
      setLost({ href: seen.owner, pathname });
    }
    setSeen({ me, owner, pathname });
  }

  // A loss outlives the render that saw it only while the page is still open.
  useEffect(() => {
    if (lost && lost.pathname !== pathname) setLost(null);
  }, [lost, pathname]);

  return lost !== null && lost.pathname === pathname && !listed(lost.href);
}
