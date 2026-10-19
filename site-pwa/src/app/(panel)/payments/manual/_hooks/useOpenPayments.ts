"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveReread } from "@/hooks/useLiveReread";
import { manualQueueApi, type ManualQueueApi, type VerifyingPayment } from "@/lib/billing-api";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { manualLiveOf } from "../_lib/manual-live";

/**
 * Calls `reread` when an open payment of this queue moves (RT-1-j) — for the
 * screen and its dashboard widget. `resellerId`: a workspace's reseller
 * (F-093-w); `null`, the session's own queue.
 */
export function useOpenPaymentsLive(reread: () => void, resellerId: string | null = null): void {
  const { me } = usePanelSession();
  const [first, second] = manualLiveOf(me ?? null, resellerId);
  useLiveReread(first.channel, first.types, reread, first.accepts);
  useLiveReread(second?.channel ?? null, second?.types ?? [], reread, second?.accepts);
}

/** The manual-payments list (F-093-o) of one queue: read on mount, again on `reload` and on every RT-1-j event. */
export function useOpenPayments(resellerId: string | null = null) {
  const api: ManualQueueApi = useMemo(() => manualQueueApi(resellerId), [resellerId]);
  const [rows, setRows] = useState<VerifyingPayment[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  // State is set only when the read lands, so the mount effect sets none synchronously.
  const reload = useCallback(
    () =>
      api
        .list()
        .then((list) => {
          setRows(list);
          setError(null);
        }, setError)
        .finally(() => setLoading(false)),
    [api],
  );

  useEffect(() => {
    void reload();
  }, [reload]);
  useOpenPaymentsLive(() => void reload(), resellerId);

  return { api, rows, isLoading, error, reload };
}
