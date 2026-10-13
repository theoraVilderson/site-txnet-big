"use client";

import { useEffect, useState } from "react";
import { RealtimeEvents } from "@/generated/wire";
import { useLiveReread } from "@/hooks/useLiveReread";
import { userChannel } from "@/lib/realtime";
import { resellerPurchaseApi, type OwnedReseller } from "@/lib/tenant-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { isPlatformUser } from "@/lib/tenant-type";

/**
 * A paid renewal (F-019-c1), any status change — by hand or by the platform
 * (F-019-c2) — and a grace the platform owner extends (F-019-c3) are pushed
 * as themselves; a renewal's warning is an inbox row, and that row is live
 * (F-035-b).
 */
const RENEWAL_EVENTS = [
  RealtimeEvents.tenantSubscriptionRenewed,
  RealtimeEvents.tenantStatusChanged,
  RealtimeEvents.tenantSubscriptionGraceExtended,
  RealtimeEvents.notificationCreated,
];

/**
 * The reseller the caller holds, for My services (F-502-v): `GET
 * /purchase/mine`, asked only of a platform user who is not its owner — the
 * one caller who can buy one (the sidebar's `useHoldsLiveReseller` gate).
 * `null` while unasked, pending, answered none or failed: the section is a
 * view beside the Grants and its failure costs only itself.
 *
 * Re-read when the user's channel says a renewal was paid, the status
 * changed, the grace moved, or that an inbox row arrived — a renewal's "payment due" and "suspended" are both one — and
 * after a reconnect (C-14). Never on a clock.
 */
export function useOwnedReseller(): OwnedReseller | null {
  const { me, group } = usePanelSession();
  const userId = group?.current.userId ?? null;
  const canHold = me != null && isPlatformUser(me.tenant);
  const [reseller, setReseller] = useState<OwnedReseller | null>(null);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    if (!canHold) return;
    let live = true;
    resellerPurchaseApi
      .mine()
      .then((r) => live && setReseller(r.reseller))
      // A failed re-read keeps the last answer: the event is a hint, not the record.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [canHold, userId, asked]);

  useLiveReread(canHold && userId ? userChannel(userId) : null, RENEWAL_EVENTS, () => setAsked((n) => n + 1));

  return canHold ? reseller : null;
}
