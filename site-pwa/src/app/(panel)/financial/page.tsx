import { Suspense } from "react";
import { TableSkeleton } from "../_components/kit/TableSkeleton";
import { FinancialView } from "./_components/FinancialView";

/**
 * `/financial` — the financial history page (F-093-d).
 *
 * A server shell around one client view, for one reason: `FinancialView` reads
 * the query string with `useSearchParams`, and Next will not prerender a page
 * that does without a `Suspense` boundary over it. Legacy's boundary was keyed
 * to the serialised params so that a filter change re-threw it and showed the
 * skeleton; here the fetch is a client read keyed to the same filters
 * (`useFinancialPage`), so this boundary only covers the first paint and the
 * key is not needed for the rest.
 */
export default function FinancialPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={5} columns={5} withPagination />
        </div>
      }
    >
      <FinancialView />
    </Suspense>
  );
}
