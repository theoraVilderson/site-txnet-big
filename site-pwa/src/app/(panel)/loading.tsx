import { Skeleton } from "./_components/kit/Skeleton";

/**
 * The page area while a route's server part loads (UX-1-i, `contract.ux.md`
 * N9). The shell stays drawn around it; this is the shape of a page inside
 * it — a header, then cards — so nothing jumps when the page arrives.
 */
export default function PanelLoading() {
  return (
    <div aria-busy="true" className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
      <div className="space-y-2">
        <Skeleton className="hidden h-3 w-40 md:block" />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-32 rounded-3xl" />
        ))}
      </div>
    </div>
  );
}
