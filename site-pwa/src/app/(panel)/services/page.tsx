import { Suspense } from "react";
import { TableSkeleton } from "../_components/kit/TableSkeleton";
import { MyServicesView } from "./_components/MyServicesView";

/**
 * `/services` — the "my services" page (F-502-s), the sidebar's `my-services`
 * entry.
 *
 * A server shell around one client view, for the financial page's reason:
 * `MyServicesView` reads the query string with `useSearchParams`, and Next
 * will not prerender a page that does without a `Suspense` boundary over it.
 */
export default function MyServicesPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={3} columns={3} withPagination />
        </div>
      }
    >
      <MyServicesView />
    </Suspense>
  );
}
