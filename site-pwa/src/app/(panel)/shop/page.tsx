"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ShopView } from "./_components/ShopView";

/**
 * `/shop` — the shop (F-111-e), the sidebar's `buy` entry.
 *
 * `?invoice=` opens it on one invoice: where the top-up page sends a user back
 * after topping up for its shortfall. `?variant=` opens it on one plan's
 * checkout: where a suggestion's call to action goes (F-038-h); a plan the
 * shop does not offer leaves the list. `useSearchParams` needs a `Suspense`
 * boundary for Next to prerender the page, as on My services.
 */
export default function ShopPage() {
  return (
    <Suspense fallback={null}>
      <ShopFromQuery />
    </Suspense>
  );
}

function ShopFromQuery() {
  const query = useSearchParams();
  const invoiceId = query.get("invoice");
  const variantId = invoiceId ? null : query.get("variant");
  return <ShopView key={invoiceId ?? variantId ?? "list"} invoiceId={invoiceId} variantId={variantId} />;
}
