"use client";

import { useCallback, useEffect, useState } from "react";
import { RealtimeEvents } from "@/generated/wire";
import { useLiveReread } from "@/hooks/useLiveReread";
import { billingApi, type VerifyingPayment } from "@/lib/billing-api";
import { tenantChannelOf } from "@/lib/tenant-channel";
import { usePanelSession } from "../../../_context/PanelSessionContext";

/** What the open list re-reads on (RT-1-j): billing says an open payment this tenant lists appeared, moved or settled. */
export const OPEN_PAYMENT_EVENTS: readonly string[] = [RealtimeEvents.paymentOpenChanged];

/** Calls `reread` when an open payment moves (RT-1-j) — for the screen and its dashboard widget. */
export function useOpenPaymentsLive(reread: () => void): void {
  const { me } = usePanelSession();
  useLiveReread(tenantChannelOf(me), OPEN_PAYMENT_EVENTS, reread);
}

/** The manual-payments list (F-093-o): read on mount, again on `reload` and on every RT-1-j event. */
export function useOpenPayments() {
  const [rows, setRows] = useState<VerifyingPayment[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  // State is set only when the read lands, so the mount effect sets none synchronously.
  const reload = useCallback(
    () =>
      billingApi
        .manualPayments()
        .then((list) => {
          setRows(list);
          setError(null);
        }, setError)
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload]);
  useOpenPaymentsLive(() => void reload());

  return { rows, isLoading, error, reload };
}
