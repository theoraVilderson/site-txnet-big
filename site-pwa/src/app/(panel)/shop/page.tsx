"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ShopView } from "./_components/ShopView";

/**
 * `/shop` — the shop (F-111-e), the sidebar's `buy` entry.
 *
 * `?invoice=` opens it on one invoice: where the top-up page sends a user back
 * after topping up for its shortfall. `useSearchParams` needs a `Suspense`
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
  const invoiceId = useSearchParams().get("invoice");
  return <ShopView key={invoiceId ?? "list"} invoiceId={invoiceId} />;
}
