"use client";

import { useCallback, useEffect, useState } from "react";
import { useLiveReread } from "@/hooks/useLiveReread";
import { billingApi, type TransferStatus } from "@/lib/billing-api";
import { userChannel } from "@/lib/realtime";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { TRANSFER_EVENTS } from "../_lib/transfer-page";

/**
 * One manual transfer as its payer sees it (F-803-i): read on mount, again on
 * billing crediting or reversing a payment on the payer's own channel, and on
 * the tab becoming visible — a person's return or rejection sends the payer no
 * event, and an event missed while hidden reached nobody. Nothing polls (C-14).
 */
export function useTransfer(paymentId: string) {
  const { group } = usePanelSession();
  const userId = group?.current.userId ?? null;
  const [transfer, setTransfer] = useState<TransferStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setLoading] = useState(true);

  // State is set only when the read lands, so the mount effect sets none synchronously.
  const reload = useCallback(
    () =>
      billingApi
        .transferStatus(paymentId)
        .then((t) => {
          setTransfer(t);
          setError(null);
        }, setError)
        .finally(() => setLoading(false)),
    [paymentId],
  );

  useEffect(() => {
    void reload();
    const visible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [reload]);
  useLiveReread(userId ? userChannel(userId) : null, TRANSFER_EVENTS, () => void reload());

  return { transfer, error, isLoading, reload };
}
