"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeEvents } from "@/generated/wire";
import { useLiveReread } from "@/hooks/useLiveReread";
import { billingApi } from "@/lib/billing-api";
import { userChannel } from "@/lib/realtime";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { pendingStateOf, type PendingState } from "../_lib/pending-payment";

/** Every credit and every reversal writes it on the payer's `user:` (RT-1-c). */
const PENDING_EVENTS = [RealtimeEvents.walletChanged] as const;

/**
 * The payment `/payment/pending` waits on, read on mount and again when it may
 * have moved (RT-1-c, C-14): `billing.wallet.changed` on the payer's channel,
 * and the tab becoming visible — a payment that closes without credit (expiry,
 * rejection) has no event. Once it has an outcome nothing is asked again.
 */
export function usePendingPayment(paymentId: string): PendingState {
  const { group } = usePanelSession();
  const userId = group?.current.userId ?? null;
  const [state, setState] = useState<PendingState>({ kind: "waiting" });
  const waiting = state.kind === "waiting";

  // Dropped on unmount and on a new payment: a late answer is not this page's.
  const live = useRef(true);
  const check = useCallback(async () => {
    const row = await billingApi.walletPayment(paymentId).catch(() => null);
    if (live.current) setState(pendingStateOf(row));
  }, [paymentId]);

  useEffect(() => {
    live.current = true;
    void check();
    return () => {
      live.current = false;
    };
  }, [check]);

  useEffect(() => {
    if (!waiting) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [waiting, check]);

  useLiveReread(waiting && userId ? userChannel(userId) : null, PENDING_EVENTS, () => void check());
  return state;
}
