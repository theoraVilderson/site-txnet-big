"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { billingApi } from "@/lib/billing-api";
import { holdsPermission } from "@/lib/permissions";
import { userChannel } from "@/lib/realtime";
import { tenantChannelOf } from "@/lib/tenant-channel";
import { RealtimeEvents } from "@/generated/wire";
import { useLiveReread } from "@/hooks/useLiveReread";
import { supportAgentApi, supportApi } from "@/lib/support-api";
import { usePanelSession } from "../_context/PanelSessionContext";
import { OPEN_PAYMENT_EVENTS } from "../payments/manual/_lib/manual-live";
import { INBOX_EVENTS } from "../support/_lib/support-agent";

/** The menu entries that carry a count (N4), by menu id. */
export type BadgedEntry = "support" | "support-inbox" | "manual-payments";
export type MenuBadges = Partial<Record<BadgedEntry, number>>;

const BADGE_EVENTS = [RealtimeEvents.notificationCreated];
/** RT-1-j, RT-1-g: the payments list and the inbox move on the tenant's channel. */
const TENANT_BADGE_EVENTS = [...OPEN_PAYMENT_EVENTS, ...INBOX_EVENTS];

/**
 * The sidebar's counts (UX-1-j, `contract.ux.md` N4), each over the first page
 * its own screen reads: support — the unread total of the caller's threads;
 * the support inbox — the `unassigned` view; manual payments — the open list.
 * A count is asked only of a caller whose menu shows the entry. A failed read
 * keeps the last count: a badge is a hint, and a blink to nothing is a lie.
 *
 * Re-read on mount, on a notification on the caller's channel (a reply is
 * one), on the inbox or the open payments moving on the tenant's (RT-1-g,
 * RT-1-j), and on the tab becoming visible — an event missed while hidden.
 * Nothing polls (C-14).
 */
export function useMenuBadges(): MenuBadges {
  const { me, group } = usePanelSession();
  const userId = group?.current.userId ?? null;
  const signedIn = me !== null && me !== undefined;
  const agent = holdsPermission(me?.permissions, "support.agent");
  const confirms = holdsPermission(me?.permissions, "payment.confirm_manual");
  const [badges, setBadges] = useState<MenuBadges>({});

  const read = useCallback(() => {
    const keep = (id: BadgedEntry, ask: () => Promise<number>) =>
      ask().then(
        (n) => setBadges((b) => (b[id] === n ? b : { ...b, [id]: n })),
        () => undefined,
      );
    if (signedIn) keep("support", async () => (await supportApi.list()).items.reduce((sum, c) => sum + (c.unread ?? 0), 0));
    if (agent) keep("support-inbox", async () => (await supportAgentApi.inbox("unassigned")).items.length);
    if (confirms) keep("manual-payments", async () => (await billingApi.manualPayments()).length);
  }, [signedIn, agent, confirms]);

  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  }, [read]);

  useEffect(() => {
    read();
    const tick = () => {
      if (document.visibilityState === "visible") readRef.current();
    };
    document.addEventListener("visibilitychange", tick);
    return () => document.removeEventListener("visibilitychange", tick);
  }, [read]);

  useLiveReread(userId ? userChannel(userId) : null, BADGE_EVENTS, () => readRef.current());
  useLiveReread(tenantChannelOf(me ?? null), TENANT_BADGE_EVENTS, () => readRef.current());

  return badges;
}
