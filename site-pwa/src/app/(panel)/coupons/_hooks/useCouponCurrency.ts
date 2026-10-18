"use client";

import { useEffect, useState } from "react";
import type { Me } from "@/lib/auth-api";
import { billingApi } from "@/lib/billing-api";
import { UUID } from "../_lib/gift-batch";

/** What billing's `GET /coupons/currency` is asked for `ownerTenant` (`null` = the platform's); `null` while the id is still being typed. */
export const currencyOwnerQuery = (ownerTenant: string | null): string | null => (ownerTenant === null ? "platform" : UUID.test(ownerTenant) ? ownerTenant : null);

/**
 * The currency a new coupon, batch or rule of `ownerTenant` is written in
 * (F-116-h11), as billing decides it — `null` until it answers, or when it
 * refuses, and the form then names no currency rather than a guessed one.
 * A `null` `me` asks nothing: not signed in yet, or a row that has its own.
 */
export function useCouponCurrency(me: Me | null, ownerTenant: string | null): string | null {
  const query = me ? currencyOwnerQuery(ownerTenant) : null;
  const [answer, setAnswer] = useState<{ query: string; code: string } | null>(null);
  useEffect(() => {
    if (!query) return;
    let live = true;
    billingApi.couponCurrency(query).then(
      ({ code }) => live && setAnswer({ query, code }),
      // A refusal is billing's answer to the write as well; the form names no currency until then.
      () => live && setAnswer(null),
    );
    return () => {
      live = false;
    };
  }, [query]);
  // Derived, not mirrored (C-30): an answer for another owner is not this one's.
  return answer && answer.query === query ? answer.code : null;
}
