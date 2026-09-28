"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { billingApi } from "@/lib/billing-api";
import { userChannel } from "@/lib/realtime";
import { usePanelRealtime } from "../_context/PanelRealtimeContext";
import { usePanelSession } from "../_context/PanelSessionContext";

export interface WalletBalanceState {
  /**
   * The balance as billing answered it — a decimal string in `currencyCode`,
   * or `null` while there is none to show. `null` is not zero:
   * `"0.00"` is a real balance a user with no wallet yet has.
   */
  balance: string | null;
  /** The wallet's currency, as the same answer named it (F-116-h3); `null` with `balance`. */
  currencyCode: string | null;
  isLoading: boolean;
  /** The read did not land. There is no server text for it — the caller shows its own line. */
  failed: boolean;
  /** Ask again. The top bar offers this after a failed read. */
  refresh: () => void;
}

/**
 * The wallet balance the top bar shows (F-093-c).
 *
 * **It never computes a balance.** It holds whatever `billing` last answered,
 * and a wallet event over the panel socket makes it ask again. That is the
 * whole rule, and it is a correction rather than a style: legacy kept the
 * balance as a number in a client store and let components adjust it, which is
 * how a refused gift code showed success over a balance of `NaN` (F-093-g's
 * note) and how the financial page learned to count failed attempts as
 * movements (F-092-n's note). `wallet.cachedBalance` is written only inside the
 * transaction that appends the proving ledger row, so re-reading is not the
 * cautious option here — it is the only one that can be right.
 *
 * Re-reading also means the event's *payload is never read*, which is what lets
 * this ship before its producer does: `F-092-j` is the row that will publish a
 * payment event, and there is no agreed shape for one yet. A hook that parsed
 * an amount would have to guess that shape and would break quietly when the
 * guess was wrong. This one only needs the event to arrive.
 */
export function useWalletBalance(): WalletBalanceState {
  const { group } = usePanelSession();
  const userId = group?.current.userId ?? null;
  const client = usePanelRealtime();

  const [balance, setBalance] = useState<string | null>(null);
  const [currencyCode, setCurrencyCode] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // Bumped to ask again. The read lives in one effect keyed to the account and
  // this counter, so a refresh and an account switch cannot race into two
  // in-flight reads whose answers land in the wrong order.
  const [asked, setAsked] = useState(0);
  const refresh = useCallback(() => setAsked((n) => n + 1), []);

  // The socket effect must not re-run when `refresh` does, or every event would
  // also cost a resubscribe — and a channel dropped and re-declared is a window
  // in which the next event is simply lost.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    setIsLoading(true);
    (async () => {
      try {
        const next = await billingApi.walletBalance();
        if (!alive) return;
        setBalance(next.balance);
        setCurrencyCode(next.currencyCode);
        setFailed(false);
      } catch {
        // Nothing translated comes back for a balance — the route raises no
        // domain error at all (`billing/contract.history.md`), so a failure is
        // either the limiter or the network. Keep the last good figure rather
        // than blanking a balance that was correct a second ago.
        if (alive) setFailed(true);
      } finally {
        if (alive) setIsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId, asked]);

  useEffect(() => {
    if (!client || !userId) return;
    // Any event on this user's own channel is a reason to ask again. Today only
    // a payment can move a wallet; tomorrow a transfer or a spin can, and a
    // filter written now would have to be widened by each of them.
    return client.subscribe(userChannel(userId), {
      onMessage: () => refreshRef.current(),
      // A payment credited while the socket was down was told to nobody, so a
      // reconnect asks again (F-070-d) — the same read an event would cost.
      onMissed: () => refreshRef.current(),
    });
  }, [client, userId]);

  return { balance, currencyCode, isLoading, failed, refresh };
}
