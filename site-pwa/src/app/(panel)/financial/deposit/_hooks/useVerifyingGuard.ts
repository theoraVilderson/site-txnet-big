"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { billingApi, type WalletPaymentRow } from "@/lib/billing-api";

/**
 * The caller's pending attempts, newest first. A verifying payment is always
 * `pending` (F-092-x), and one started long enough ago to fall off 20 rows has
 * long been flagged for a person.
 */
export const VERIFYING_QUERY = "page=1&pageSize=20&statuses=pending";

async function findVerifying(): Promise<WalletPaymentRow | null> {
  const page = await billingApi.walletPayments(VERIFYING_QUERY);
  return page.rows.find((r) => r.verifying) ?? null;
}

/**
 * Warn before a second payment while one is verifying (F-093-m, ADR-0044
 * decision 7).
 *
 * **Warn and confirm, never block** — the user's choice, 2026-09-14. The payer
 * may know the first one failed at their bank; the panel cannot. So:
 *  - `verifying` is what the page shows when it opens;
 *  - `guard(proceed)` re-reads at the moment of paying (the payment may have
 *    settled since the page opened) and either proceeds or sets `warning`;
 *  - `confirm()` proceeds regardless; `cancel()` drops it;
 *  - a check that fails proceeds. A courtesy must not become a gate.
 */
export function useVerifyingGuard() {
  const [verifying, setVerifying] = useState<WalletPaymentRow | null>(null);
  const [warning, setWarning] = useState<WalletPaymentRow | null>(null);
  const pending = useRef<(() => void) | null>(null);

  useEffect(() => {
    let alive = true;
    findVerifying()
      .then((found) => alive && setVerifying(found))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const guard = useCallback(async (proceed: () => void) => {
    const found = await findVerifying().catch(() => null);
    setVerifying(found);
    if (!found) {
      proceed();
      return;
    }
    pending.current = proceed;
    setWarning(found);
  }, []);

  const confirm = useCallback(() => {
    const proceed = pending.current;
    pending.current = null;
    setWarning(null);
    proceed?.();
  }, []);

  const cancel = useCallback(() => {
    pending.current = null;
    setWarning(null);
  }, []);

  return { verifying, warning, guard, confirm, cancel };
}
