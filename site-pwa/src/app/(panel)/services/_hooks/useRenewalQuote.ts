"use client";

import { useEffect, useState } from "react";
import { billingApi, type RenewalQuote } from "@/lib/billing-api";

/**
 * How long typing rests before the price is asked. The quote shares the shop
 * list's `SHOP_OFFERS` budget, so one read per settled amount, not per key.
 */
const QUOTE_AFTER_MS = 400;

/**
 * Billing's price for GiB and days typed on one Grant (F-305-g over F-305-e),
 * read once typing rests — never multiplied here (`contract.renewal.md` rule
 * 4). `null` amounts ask nothing. An answer for an older amount is never shown
 * as this one's.
 */
export function useRenewalQuote(grantId: string, gib: number | null, days: number | null) {
  const asked = gib === null || days === null ? null : `${gib}:${days}`;
  const [answer, setAnswer] = useState<{ asked: string; quote: RenewalQuote | null; error: unknown } | null>(null);

  useEffect(() => {
    if (asked === null || gib === null || days === null) return;
    let alive = true;
    const timer = setTimeout(() => {
      billingApi.renewalQuote(grantId, gib, days).then(
        (quote) => alive && setAnswer({ asked, quote, error: null }),
        (error: unknown) => alive && setAnswer({ asked, quote: null, error }),
      );
    }, QUOTE_AFTER_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [grantId, asked, gib, days]);

  const current = answer !== null && answer.asked === asked ? answer : null;
  return { quote: current?.quote ?? null, error: current?.error ?? null, pending: asked !== null && current === null };
}
