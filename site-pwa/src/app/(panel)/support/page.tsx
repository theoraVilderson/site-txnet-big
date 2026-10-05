import { Suspense } from "react";
import { SupportView } from "./_components/SupportView";

/**
 * `/support` — the user's conversations with support, and a new one (F-033-o).
 * `SupportView` reads `?new=1` with `useSearchParams`, and Next will not
 * prerender a page that does without a `Suspense` boundary over it.
 */
export default function SupportPage() {
  return (
    <Suspense fallback={null}>
      <SupportView />
    </Suspense>
  );
}
